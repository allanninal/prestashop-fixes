/**
 * Repair PrestaShop products left with a dangling id_category_default after a
 * category deletion.
 *
 * DeleteCategoryHandler only reassigns a product's categories when the deletion
 * would leave it with zero categories at all. It never checks whether the
 * deleted category was that product's default while the product still has
 * other valid categories, so id_category_default keeps pointing at a category
 * id that no longer exists in ps_category (PrestaShop/PrestaShop issue #30219,
 * and related issues #28016 and #9811).
 *
 * This script builds the set of valid category ids, walks every product, and
 * runs a pure decision function that picks a replacement default from the
 * product's own remaining valid categories, falling back to the shop's root
 * category. It logs every proposed change. A corrective PUT that resends the
 * full product body is only sent when DRY_RUN=false.
 *
 * Guide: https://www.allanninal.dev/prestashop/product-missing-default-category-after-deletion/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const FALLBACK_ROOT_CATEGORY_ID = Number(process.env.FALLBACK_ROOT_CATEGORY_ID || 2);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function, no I/O.
 *
 * productId: number
 * currentDefaultId: number, the product's current id_category_default
 * associatedCategoryIds: number[], the product's full category list
 * validCategoryIds: Set<number>, every category id that still exists
 * fallbackRootId: number, used only when the product has no valid
 *   categories of its own left
 *
 * Returns an object describing what to do. action is "none" when the current
 * default is already valid, "reassign" when a safe replacement was found, or
 * "flag_manual" when no valid category exists to fall back to.
 */
export function chooseValidDefaultCategory(productId, currentDefaultId, associatedCategoryIds,
                                            validCategoryIds, fallbackRootId = 2) {
  if (validCategoryIds.has(currentDefaultId)) {
    return { id_product: productId, action: "none", new_default: currentDefaultId };
  }

  const candidates = associatedCategoryIds.filter(
    (cid) => validCategoryIds.has(cid) && cid !== currentDefaultId
  );
  const newDefault = candidates.length
    ? Math.max(...candidates)
    : (validCategoryIds.has(fallbackRootId) ? fallbackRootId : null);

  return {
    id_product: productId,
    action: newDefault ? "reassign" : "flag_manual",
    old_default: currentDefaultId,
    new_default: newDefault,
  };
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

async function allCategoryIds(pageSize = 100) {
  const ids = new Set();
  let offset = 0;
  while (true) {
    const data = await apiGet("categories", { display: "full", limit: `${offset},${pageSize}` });
    const rows = data.categories || [];
    if (!rows.length) return ids;
    for (const row of rows) ids.add(Number(row.id));
    offset += pageSize;
  }
}

async function* allProducts(pageSize = 100) {
  let offset = 0;
  while (true) {
    const data = await apiGet("products", { display: "full", limit: `${offset},${pageSize}` });
    const rows = data.products || [];
    if (!rows.length) return;
    for (const row of rows) yield row;
    offset += pageSize;
  }
}

function associatedCategoryIds(product) {
  const categories = product.associations?.categories?.category || [];
  return categories.map((row) => Number(row.id));
}

async function repairProductDefaultCategory(productId, newDefaultId) {
  const data = await apiGet(`products/${productId}`);
  const product = data.product;
  product.id_category_default = newDefaultId;

  product.associations = product.associations || {};
  product.associations.categories = product.associations.categories || {};
  const rows = (product.associations.categories.category = product.associations.categories.category || []);
  if (!rows.some((row) => Number(row.id) === newDefaultId)) {
    rows.push({ id: newDefaultId });
  }

  return apiPut(`products/${productId}`, "product", product);
}

export async function run() {
  const validCategoryIds = await allCategoryIds();
  let reassigned = 0;
  let flagged = 0;
  for await (const product of allProducts()) {
    const productId = Number(product.id);
    const currentDefaultId = Number(product.id_category_default || 0);
    const decision = chooseValidDefaultCategory(
      productId, currentDefaultId, associatedCategoryIds(product),
      validCategoryIds, FALLBACK_ROOT_CATEGORY_ID,
    );
    if (decision.action === "none") continue;
    if (decision.action === "flag_manual") {
      flagged++;
      console.warn(`Product id=${productId} has no valid category to fall back to. Needs manual review.`);
      continue;
    }

    console.log(
      `Product id=${productId} old id_category_default=${decision.old_default} new id_category_default=${decision.new_default}. ${DRY_RUN ? "would reassign" : "reassigning"}`
    );
    if (!DRY_RUN) await repairProductDefaultCategory(productId, decision.new_default);
    reassigned++;
  }
  console.log(`Done. ${reassigned} product(s) ${DRY_RUN ? "to reassign" : "reassigned"}, ${flagged} flagged for manual review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
