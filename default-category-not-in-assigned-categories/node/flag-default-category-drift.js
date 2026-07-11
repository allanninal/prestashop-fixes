/**
 * Flag PrestaShop products whose default category is not among their assigned categories.
 *
 * The backend product editor writes category associations to category_product
 * instantly, over AJAX, the moment a merchant checks or unchecks a box, without
 * waiting for Save. It never re-validates id_category_default at that moment. If
 * the category that was the default gets unchecked, or a category is deleted
 * store-wide, id_category_default keeps pointing at a category the product is no
 * longer linked to (PrestaShop/PrestaShop issues #28016 and #30219). Catalog
 * import can cause the same drift when only partial category data is sent for a
 * row and the importer overwrites id_category_default without validating it
 * against the submitted categories (issue #32412).
 *
 * This script pages through active products from the webservice, runs a pure
 * decision function that flags any product where id_category_default is not in
 * its associations.categories.category[] ids, and reports by default. A
 * corrective PUT that resends the full product body with only
 * id_category_default corrected is only sent when DRY_RUN=false and --auto-fix
 * is passed, one product id at a time, using the lowest id currently in the
 * associations as the deterministic replacement.
 *
 * Guide: https://www.allanninal.dev/prestashop/default-category-not-in-assigned-categories/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const ROOT_CATEGORY_ID = Number(process.env.ROOT_CATEGORY_ID || 2);
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 50);

/**
 * Pure decision function, no I/O.
 *
 * idCategoryDefault: number | string | null | undefined, the product's
 *   id_category_default value as read from the webservice.
 * associatedCategoryIds: (number | string)[], the ids from
 *   associations.categories.category[].
 *
 * Returns null when the default is fine (it is present in the associated
 * ids, or there is no default to check). Returns an object with
 * idCategoryDefault (the stale value, as a number) and validCategoryIds (the
 * sorted, de-duplicated associations list, as numbers) when the default is
 * not among them, so a human or an auto-fix step can pick a sane replacement.
 */
export function findDefaultCategoryDrift(idCategoryDefault, associatedCategoryIds) {
  const validIds = [...new Set((associatedCategoryIds || []).map(Number))].sort((a, b) => a - b);
  if (idCategoryDefault == null) return null;
  if (validIds.includes(Number(idCategoryDefault))) return null;
  return {
    idCategoryDefault: Number(idCategoryDefault),
    validCategoryIds: validIds,
  };
}

/** Extract the assigned category ids out of a product's webservice body. */
export function assignedCategoryIds(product) {
  const categories = product.associations?.categories?.category || [];
  return categories.map((row) => Number(row.id));
}

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function apiPut(path, resourceKey, body, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ [resourceKey]: body }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT ${path}`);
  return res.json();
}

async function* activeProducts() {
  let offset = 0;
  while (true) {
    const data = await apiGet("products", {
      display: "full",
      "filter[active]": 1,
      limit: `${offset},${PAGE_SIZE}`,
    });
    const rows = data.products || [];
    if (!rows.length) return;
    for (const row of rows) yield row;
    offset += PAGE_SIZE;
  }
}

/** Optional cross-check: a 404 confirms the deleted-category variant (issue #30219). */
async function categoryStillExists(categoryId) {
  try {
    await apiGet(`categories/${categoryId}`);
    return true;
  } catch (err) {
    if (String(err.message).includes("404")) return false;
    throw err;
  }
}

async function repairDefaultCategory(product, drift) {
  // Always fetch-modify-PUT the complete product body, never hand-construct
  // it, and never touch associations.categories, only id_category_default.
  const replacement = drift.validCategoryIds.length ? drift.validCategoryIds[0] : ROOT_CATEGORY_ID;
  const body = { ...product, id_category_default: replacement };
  await apiPut(`products/${product.id}`, "product", body);
  return replacement;
}

export async function run(autoFix = false) {
  let flagged = 0;
  let repaired = 0;
  for await (const product of activeProducts()) {
    const drift = findDefaultCategoryDrift(product.id_category_default, assignedCategoryIds(product));
    if (drift === null) continue;
    flagged++;
    console.warn(`Product id=${product.id} id_category_default=${drift.idCategoryDefault} (stale) valid_category_ids=${JSON.stringify(drift.validCategoryIds)}`);
    if (!DRY_RUN && autoFix) {
      const replacement = await repairDefaultCategory(product, drift);
      repaired++;
      console.log(`Repaired product id=${product.id}: id_category_default ${drift.idCategoryDefault} -> ${replacement}.`);
    }
  }
  console.log(`Done. ${flagged} product(s) flagged, ${repaired} repaired.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const autoFix = process.argv.includes("--auto-fix");
  run(autoFix).catch((err) => { console.error(err); process.exit(1); });
}
