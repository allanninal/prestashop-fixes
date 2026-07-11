/**
 * Detect and repair PrestaShop products created via webservice that are invisible
 * on the storefront despite showing active in the back office.
 *
 * The full admin product save wires up category_product links, shop associations,
 * and search index rows as side effects of the whole controller save chain. The
 * webservice Product::add()/update() path only writes what the submitted resource
 * body explicitly includes. A payload that sets active=1 without an
 * associations.categories block carrying id_category_default, or without an
 * associations.shops entry, leaves the product active in product/product_shop but
 * with no category link and no shop association, so front-end catalog queries that
 * join through those tables never return it (PrestaShop/PrestaShop issues #15317
 * and #28409).
 *
 * This script lists recently created active products with display=full, inspects
 * the associations block already returned, cross-checks id_category_default against
 * real categories, and flags or repairs the missing links. Repair merges the fix
 * onto the full current resource and PUTs it back, then re-GETs to confirm. A
 * product whose default category itself is invalid is only ever flagged, never
 * auto-written, since guessing a replacement category could mis-file it.
 *
 * Guide: https://www.allanninal.dev/prestashop/webservice-product-invisible-on-storefront/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const EXPECTED_SHOP_IDS = (process.env.EXPECTED_SHOP_IDS || "1")
  .split(",").map((s) => s.trim()).filter(Boolean).map(Number);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * product: {active: 0|1, visibility: "both"|"catalog"|"search"|"none",
 *           id_category_default: number, associations: {categories: number[], shops: number[]}}
 * context: {expectedShopIds: number[], validCategoryIds: number[]}
 *
 * Returns {status: "ok"|"needs_repair"|"unrepairable", missing: string[], patch: object|null}.
 */
export function decideProductRepair(product, context) {
  if (product.active !== 1) {
    return { status: "ok", missing: [], patch: null };
  }

  const missing = [];
  const { categories, shops } = product.associations;
  const idCategoryDefault = product.id_category_default;

  if (categories.length === 0) {
    missing.push("categories");
  } else if (!categories.includes(idCategoryDefault)) {
    missing.push("id_category_default_not_in_categories");
  }

  const expectedShopIds = context.expectedShopIds;
  if (shops.length === 0 || !expectedShopIds.some((id) => shops.includes(id))) {
    missing.push("shops");
  }

  if (product.visibility === "none") {
    missing.push("visibility");
  }

  if (!context.validCategoryIds.includes(idCategoryDefault)) {
    missing.push("default_category_invalid");
    return { status: "unrepairable", missing, patch: null };
  }

  if (missing.length === 0) {
    return { status: "ok", missing: [], patch: null };
  }

  const patch = {};
  if (missing.includes("categories") || missing.includes("id_category_default_not_in_categories")) {
    patch.associations = { categories: [...new Set([...categories, idCategoryDefault])] };
  }
  if (missing.includes("shops")) {
    patch.associations = { ...(patch.associations || {}), shops: expectedShopIds };
  }
  if (missing.includes("visibility")) {
    patch.visibility = "both";
  }

  return { status: "needs_repair", missing, patch };
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function apiPut(path, resourceKey, body) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ [resourceKey]: body }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT ${path}`);
  return res.json();
}

async function listRecentActiveProducts(dateFrom, dateTo, limit = 100) {
  const data = await apiGet("products", {
    display: "full",
    "filter[active]": 1,
    "filter[date_add]": `[${dateFrom},${dateTo}]`,
    limit,
  });
  return data.products || [];
}

async function categoryIsValid(idCategory) {
  try {
    const data = await apiGet(`categories/${idCategory}`);
    const category = data.category || {};
    return String(category.active) === "1";
  } catch (err) {
    return false;
  }
}

async function getFullProduct(idProduct) {
  const data = await apiGet(`products/${idProduct}`, { display: "full" });
  return data.product;
}

function mergePatchOntoResource(fullProduct, patch) {
  const merged = { ...fullProduct };
  if (patch.associations) {
    merged.associations = { ...merged.associations, ...patch.associations };
  }
  if (patch.visibility) {
    merged.visibility = patch.visibility;
  }
  return merged;
}

async function putProduct(idProduct, mergedProduct) {
  return apiPut(`products/${idProduct}`, "product", mergedProduct);
}

function toDecisionShape(product) {
  const associations = product.associations || {};
  const categories = ((associations.categories || {}).category || []).map((c) => c.id);
  const shops = ((associations.shops || {}).shop || []).map((s) => s.id);
  return {
    active: Number(product.active || 0),
    visibility: product.visibility || "both",
    id_category_default: Number(product.id_category_default || 0),
    associations: { categories, shops },
  };
}

export async function run(dateFrom = "2026-07-01", dateTo = "2026-07-11") {
  let flagged = 0;
  let repaired = 0;
  let unrepairable = 0;
  const validCategoryCache = new Map();

  for (const rawProduct of await listRecentActiveProducts(dateFrom, dateTo)) {
    const idProduct = rawProduct.id;
    const product = toDecisionShape(rawProduct);
    const idCategoryDefault = product.id_category_default;

    if (!validCategoryCache.has(idCategoryDefault)) {
      validCategoryCache.set(idCategoryDefault, await categoryIsValid(idCategoryDefault));
    }
    const validCategoryIds = [...validCategoryCache.entries()].filter(([, ok]) => ok).map(([id]) => id);

    const decision = decideProductRepair(product, { expectedShopIds: EXPECTED_SHOP_IDS, validCategoryIds });

    if (decision.status === "ok") continue;

    flagged++;
    console.warn(`Product ${idProduct} status=${decision.status} missing=${decision.missing}`);

    if (decision.status === "unrepairable") {
      unrepairable++;
      console.error(`Product ${idProduct} has an invalid id_category_default=${idCategoryDefault}, needs a human to pick a category.`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`Dry run. Would PUT products/${idProduct} with patch=${JSON.stringify(decision.patch)}`);
      continue;
    }

    const fullProduct = await getFullProduct(idProduct);
    const merged = mergePatchOntoResource(fullProduct, decision.patch);
    await putProduct(idProduct, merged);

    const confirmRaw = await getFullProduct(idProduct);
    const confirm = toDecisionShape(confirmRaw);
    const confirmDecision = decideProductRepair(confirm, { expectedShopIds: EXPECTED_SHOP_IDS, validCategoryIds });
    if (confirmDecision.status === "ok") {
      repaired++;
      console.log(`Repaired product ${idProduct}.`);
    } else {
      console.error(`Product ${idProduct} still needs_repair after PUT, missing=${confirmDecision.missing}. Not retrying silently.`);
    }
  }

  console.log(`Done. ${flagged} flagged, ${repaired} repaired, ${unrepairable} unrepairable.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
