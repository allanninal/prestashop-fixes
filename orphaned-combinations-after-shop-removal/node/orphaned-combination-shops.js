/**
 * Find PrestaShop combinations that remain linked to a shop after the parent
 * product was removed from that shop, in multistore mode.
 *
 * A product's shop association lives in product_shop. A combination's per-shop
 * presence lives in a separate table, product_attribute_shop. Removing a shop
 * from a product only cleans up product_shop. Core does not cascade that
 * removal to the combination's product_attribute_shop rows, a documented bug
 * (PrestaShop/PrestaShop#30751). This lists active shops, reads the product's
 * own shop associations, lists its combinations, and checks each combination
 * against every shop it should no longer belong to. There is no webservice
 * route to delete a single product_attribute_shop row, so this script only
 * reports the orphaned tuples. DRY_RUN defaults to true and the script never
 * writes. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/prestashop/orphaned-combinations-after-shop-removal/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = (process.env.PRESTASHOP_URL || "https://example.test").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "dummy_key";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const PRODUCT_IDS = (process.env.PRODUCT_IDS || "").split(",").map((p) => p.trim()).filter(Boolean).map(Number);

function authHeader() {
  return "Basic " + Buffer.from(`${WS_KEY}:`).toString("base64");
}

async function apiGet(path, params) {
  const url = new URL(`${BASE_URL}/api/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function activeShopIds() {
  const data = await apiGet("shops", { display: "full" });
  return new Set((data.shops || []).map((s) => Number(s.id)));
}

async function productShopIds(idProduct) {
  const data = await apiGet(`products/${idProduct}`, { display: "full" });
  const shops = data.product?.associations?.shops || [];
  return new Set(shops.map((s) => Number(s.id)));
}

async function combinationsForProduct(idProduct) {
  const data = await apiGet("combinations", { display: "full", "filter[id_product]": idProduct, limit: 0 });
  const rows = data.combinations || [];
  return rows.map((r) => Number(r.id));
}

async function combinationResolvesForShop(idProductAttribute, idShop) {
  try {
    const data = await apiGet(`combinations/${idProductAttribute}`, { display: "full", id_shop: idShop });
    return Boolean(data.combination);
  } catch (err) {
    return false;
  }
}

async function hasStockRow(idProduct, idProductAttribute, idShop) {
  const data = await apiGet("stock_availables", {
    display: "full",
    "filter[id_product]": idProduct,
    "filter[id_product_attribute]": idProductAttribute,
    "filter[id_shop]": idShop,
  });
  return Boolean(data.stock_availables);
}

export function findOrphanedCombinationShops(productShopIds, activeShopIds, combinationShopRows) {
  const orphans = [];
  for (const row of combinationShopRows) {
    const idShop = row.id_shop;
    if (!activeShopIds.has(idShop)) {
      orphans.push({ ...row, reason: "shop_inactive" });
    } else if (!productShopIds.has(idShop)) {
      orphans.push({ ...row, reason: "shop_unassigned_from_product" });
    }
  }
  return orphans;
}

export async function run() {
  const allActive = await activeShopIds();
  let reported = 0;

  for (const idProduct of PRODUCT_IDS) {
    const prodShops = await productShopIds(idProduct);
    const comboIds = await combinationsForProduct(idProduct);
    const shopsToCheck = [...allActive].filter((id) => !prodShops.has(id));

    const combinationShopRows = [];
    for (const idProductAttribute of comboIds) {
      for (const idShop of shopsToCheck) {
        if (await combinationResolvesForShop(idProductAttribute, idShop)) {
          combinationShopRows.push({ id_product_attribute: idProductAttribute, id_shop: idShop });
        }
      }
    }

    const orphans = findOrphanedCombinationShops(prodShops, allActive, combinationShopRows);
    for (const orphan of orphans) {
      const hasStock = await hasStockRow(idProduct, orphan.id_product_attribute, orphan.id_shop);
      console.warn(
        `Product ${idProduct} combination ${orphan.id_product_attribute} orphaned for shop ${orphan.id_shop} (${orphan.reason}), stock row present: ${hasStock}`
      );
      reported++;
    }
  }

  console.log(`Done. ${reported} orphaned combination-shop tuple(s) found. Report only, nothing was written.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
