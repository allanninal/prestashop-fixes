/**
 * Flag PrestaShop combinations resolved from the wrong shop context in multistore.
 *
 * Combinations are shared in one product_attribute row, but price, impact, and
 * default-attribute fields live in the per-shop product_attribute_shop association
 * table. Historically the assembler code that resolves a product's combination,
 * ProductAssemblerCore::addMissingProductFields and cache_default_attribute lookups
 * such as getIdProductAttributeByIdAttributes, queried product_attribute and
 * product_attribute_shop without consistently filtering by id_shop, so it could
 * resolve an id_product_attribute that only has an association row for a sibling
 * shop (PrestaShop/PrestaShop issue 17573). The symptom is a combination showing
 * price 0 or the wrong minimal_quantity in one shop only.
 *
 * This script enumerates shops, lists each shop's products, reads the resolved
 * combination per shop, and cross-checks it against stock_availables to learn
 * which shops a combination is actually associated with. A pure decision function
 * flags every combination whose resolved shop is not among its actual shops. It
 * reports by default. A guarded PUT to /api/combinations/{id} with ?id_shop= is
 * only logged, and only sent when DRY_RUN=false, for a confirmed missing-association
 * gap. It never deletes or reassigns the core product_attribute row.
 *
 * Guide: https://www.allanninal.dev/prestashop/wrong-shop-combination-resolved/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O, no network calls, deterministic given inputs.
 *
 * shopId: the id_shop context the product/combination was resolved under (e.g. the
 *   default/resolved id_product_attribute returned while operating in this shop).
 * productCombinations: array of objects like { id_product_attribute, id_product,
 *   price, minimal_quantity } as resolved/returned for this shop context.
 * shopAssociationsByCombination: Map of id_product_attribute -> Set of id_shop
 *   values that combination is actually associated with (derived from
 *   product_attribute_shop / combinations API).
 *
 * Returns an array of flagged objects: { id_product_attribute, id_product,
 *   resolved_in_shop, actual_shops, reason } for every combination whose
 *   resolved shopId is not among its actual associated shops.
 */
export function findShopMismatchedCombinations(shopId, productCombinations, shopAssociationsByCombination) {
  const flagged = [];
  for (const combo of productCombinations) {
    const idProductAttribute = combo.id_product_attribute;
    const actualShops = shopAssociationsByCombination.get(idProductAttribute) || new Set();
    if (!actualShops.has(shopId)) {
      flagged.push({
        id_product_attribute: idProductAttribute,
        id_product: combo.id_product,
        resolved_in_shop: shopId,
        actual_shops: [...actualShops].sort((a, b) => a - b),
        reason: "resolved id_product_attribute has no product_attribute_shop association for this shop",
      });
    }
  }
  return flagged;
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function apiPut(path, resourceKey, body, params) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ [resourceKey]: body }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT ${path}`);
  return res.json();
}

async function allShopIds() {
  const data = await apiGet("shops", { display: "full" });
  const rows = data.shops || [];
  return rows.map((row) => Number(row.id));
}

async function productsForShop(idShop) {
  const data = await apiGet("products", { display: "full", "filter[id_shop]": idShop });
  return data.products || [];
}

async function resolvedProductForShop(idProduct, idShop) {
  const data = await apiGet(`products/${idProduct}`, { id_shop: idShop, display: "full" });
  return data.product || {};
}

async function combinationsForProduct(idProduct) {
  const data = await apiGet("combinations", { display: "full", "filter[id_product]": idProduct });
  return data.combinations || [];
}

async function stockAvailableShops(idProduct, idProductAttribute) {
  const data = await apiGet("stock_availables", {
    display: "full",
    "filter[id_product]": idProduct,
    "filter[id_product_attribute]": idProductAttribute,
  });
  const rows = data.stock_availables || [];
  return new Set(rows.map((row) => Number(row.id_shop)).filter((id) => id > 0));
}

async function rescopeCombinationToShop(combination, idShop) {
  // Resend the identical combination body, scoping the query string to id_shop,
  // to create the missing product_attribute_shop association. Per the Manage
  // Multishop pattern. Never deletes or reassigns the core product_attribute row.
  const body = { ...combination };
  return apiPut(`combinations/${combination.id}`, "combination", body, {
    output_format: "JSON",
    id_shop: idShop,
  });
}

export async function run(confirm = false) {
  let flaggedTotal = 0;
  let repaired = 0;
  for (const idShop of await allShopIds()) {
    for (const product of await productsForShop(idShop)) {
      const idProduct = Number(product.id);
      const resolved = await resolvedProductForShop(idProduct, idShop);
      if (!resolved.id_default_combination) continue;
      const combinations = await combinationsForProduct(idProduct);
      if (!combinations.length) continue;
      const shopMap = new Map();
      for (const combo of combinations) {
        const idProductAttribute = Number(combo.id);
        shopMap.set(idProductAttribute, await stockAvailableShops(idProduct, idProductAttribute));
      }
      const resolvedCombo = {
        id_product_attribute: Number(resolved.id_default_combination),
        id_product: idProduct,
        price: resolved.price,
        minimal_quantity: resolved.minimal_quantity,
      };
      const flagged = findShopMismatchedCombinations(idShop, [resolvedCombo], shopMap);
      for (const item of flagged) {
        flaggedTotal++;
        console.warn(
          `Product ${item.id_product} id_product_attribute=${item.id_product_attribute} resolved_in_shop=${item.resolved_in_shop} actual_shops=${JSON.stringify(item.actual_shops)}`
        );
        if (!DRY_RUN && confirm) {
          const comboBody = combinations.find((c) => Number(c.id) === item.id_product_attribute);
          if (comboBody) {
            await rescopeCombinationToShop(comboBody, idShop);
            repaired++;
            console.log(`Repaired id_product_attribute=${item.id_product_attribute} for id_shop=${idShop}.`);
          }
        }
      }
    }
  }
  console.log(`Done. ${flaggedTotal} combination(s) flagged, ${repaired} repaired.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const confirm = process.argv.includes("--confirm");
  run(confirm).catch((err) => { console.error(err); process.exit(1); });
}
