/**
 * Detect and repair PrestaShop products that disappear days after API creation.
 *
 * Creating a product through the webservice API inserts the core Product object, but
 * skips several side effects the back office Save form normally does: position_in_category
 * in ps_category_product is left invalid (it is read only and server computed, the API
 * cannot set it), the product never reaches ps_search_index, and active, visibility, and
 * id_category_default are frequently left at defaults because they were optional fields
 * the caller forgot to send. The product row survives, but category listing, search, and
 * related products queries filter on those missing pieces, so the product quietly drops
 * out of navigation once cache expires or a reindex runs (PrestaShop/PrestaShop issues
 * #36129, #15317, #28586, #28409, #11682).
 *
 * This script polls each product back with a full field GET, cross-checks its default
 * category's own product associations and its stock, and runs a pure decision function
 * that flags products at risk. The only sanctioned write (when DRY_RUN=false) is a
 * corrective PUT that resends the full product body with explicit active, visibility,
 * id_category_default, and associations.categories, mirroring a back office Save. This
 * forces PrestaShop to rewrite the category_product row, including its position. Search
 * index rebuilding is not exposed over the webservice API, so that step is only reported
 * to a human or an ops job, never triggered here.
 *
 * Guide: https://www.allanninal.dev/prestashop/products-disappear-days-after-api-creation/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * active: the product's "active" field, as the string the API returns ("0" or "1").
 * visibility: "both", "catalog", "search", or "none".
 * idCategoryDefault: the product's default category id.
 * categoryIds: array of category ids from associations.categories.
 * stockQuantity: current stock_availables.quantity.
 * outOfStock: stock_availables.out_of_stock (0 deny, 1 allow, 2 use default policy as
 *   configured; treated here as deny for the at-risk check).
 *
 * Returns [isAtRisk, reasons]. Used both to detect at-risk products from a plain GET,
 * and to check whether a corrective PUT payload is now complete enough to be considered
 * safe, without ever touching the network.
 */
export function isProductAtRiskOfDelisting(
  active, visibility, idCategoryDefault, categoryIds, stockQuantity, outOfStock
) {
  const reasons = [];

  if (active !== "1") reasons.push('active is not "1"');
  if (visibility !== "both" && visibility !== "catalog") reasons.push("visibility is not storefront visible");
  if (idCategoryDefault === 0) reasons.push("id_category_default is 0");
  if (!categoryIds.length) reasons.push("associations.categories is empty");
  else if (!categoryIds.includes(idCategoryDefault)) reasons.push("id_category_default is not in associations.categories");
  if (stockQuantity <= 0 && outOfStock === 2) reasons.push("out of stock and denying orders");

  return [reasons.length > 0, reasons];
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

async function listRecentProductIds(minId, maxId, limit = 100) {
  const data = await apiGet("products", {
    "filter[id]": `[${minId},${maxId}]`,
    display: "[id,active,visibility,id_category_default]",
    limit,
  });
  const products = data.products || [];
  return products.map((p) => Number(p.id));
}

async function getProduct(idProduct) {
  const data = await apiGet(`products/${idProduct}`, { display: "full" });
  return data.product;
}

async function categoryProductIds(idCategory) {
  const data = await apiGet(`categories/${idCategory}`, { display: "full" });
  const category = data.category || {};
  const products = (category.associations && category.associations.products && category.associations.products.product) || [];
  return new Set(products.map((p) => Number(p.id)));
}

async function stockAvailableFor(idProduct, idProductAttribute = 0) {
  const data = await apiGet("stock_availables", {
    "filter[id_product]": idProduct,
    "filter[id_product_attribute]": idProductAttribute,
    display: "full",
  });
  const rows = data.stock_availables || [];
  return rows.length ? rows[0] : null;
}

function categoryIdsFromProduct(product) {
  const cats = (product.associations && product.associations.categories && product.associations.categories.category) || [];
  return cats.map((c) => Number(c.id));
}

function buildCorrectivePayload(product, idCategoryDefault, categoryIds) {
  const body = { ...product };
  body.active = "1";
  body.visibility = "both";
  body.id_category_default = idCategoryDefault;
  const ids = Array.from(new Set([...categoryIds, idCategoryDefault])).sort((a, b) => a - b);
  body.associations = { ...(body.associations || {}), categories: { category: ids.map((id) => ({ id })) } };
  return body;
}

async function repairProduct(idProduct, payload) {
  return apiPut(`products/${idProduct}`, "product", payload);
}

export async function run() {
  const minId = Number(process.env.SCAN_MIN_ID || 1);
  const maxId = Number(process.env.SCAN_MAX_ID || 100);

  let flagged = 0;
  let repaired = 0;

  for (const idProduct of await listRecentProductIds(minId, maxId)) {
    const product = await getProduct(idProduct);
    if (!product) continue;

    const active = String(product.active || "0");
    const visibility = product.visibility || "both";
    const idCategoryDefault = Number(product.id_category_default || 0);
    const categoryIds = categoryIdsFromProduct(product);

    const row = await stockAvailableFor(idProduct);
    const stockQuantity = row ? Number(row.quantity) : 0;
    const outOfStock = row ? Number(row.out_of_stock) : 0;

    const [atRisk, reasons] = isProductAtRiskOfDelisting(
      active, visibility, idCategoryDefault, categoryIds, stockQuantity, outOfStock
    );

    if (!atRisk) continue;

    flagged++;
    console.warn(`Product ${idProduct} at risk of delisting: ${reasons.join("; ")}`);

    if (idCategoryDefault) {
      const present = (await categoryProductIds(idCategoryDefault)).has(idProduct);
      if (!present) {
        console.warn(`Product ${idProduct} is missing from its default category ${idCategoryDefault} associations.products.`);
      }
    }

    if (DRY_RUN) {
      console.log(`Dry run: would PUT corrective payload for product ${idProduct}.`);
      continue;
    }

    const fallbackCategoryId = Number(process.env.FALLBACK_CATEGORY_ID || 2);
    const payload = buildCorrectivePayload(product, idCategoryDefault || fallbackCategoryId, categoryIds);
    await repairProduct(idProduct, payload);
    repaired++;
    console.log(
      `Repaired product ${idProduct}. Flagging for manual confirmation and for a human or cron ` +
        `to run the search index rebuild (not exposed over the webservice API).`
    );
  }

  console.log(`Done. ${flagged} product(s) flagged, ${repaired} repaired.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
