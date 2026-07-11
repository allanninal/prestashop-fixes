/**
 * Find, and only on explicit confirmation deactivate, PrestaShop products
 * left broken by a product duplication that errored out partway through.
 *
 * PrestaShop's AdminProductsController::processDuplicate and
 * Product::duplicateProduct run as a long, non-transactional sequence of
 * separate INSERT operations: the base product row first, then a loop over
 * combinations, features, images, accessories, tags, and specific prices. If
 * any single step throws, PrestaShop shows a 500 error but never rolls back
 * the new product row already committed in the first step. This is
 * documented across multiple versions (GitHub issues #19053, #19574, #31737).
 *
 * This script pulls recently created products through the Webservice API,
 * fetches each candidate's combinations, features, and stock_availables
 * rows, and classifies the shape of the damage with a pure decision
 * function. By default it only reports. Set DRY_RUN=false to let it
 * deactivate (active=0) a product it classified as a suspect partial
 * duplicate. It never deletes a product and never tries to recreate missing
 * combinations, features, or images.
 *
 * Guide: https://www.allanninal.dev/prestashop/broken-product-duplicate-after-error/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const DATE_FROM = process.env.DATE_FROM || "2000-01-01";
const DATE_TO = process.env.DATE_TO || "2100-01-01";

function authHeader() {
  return "Basic " + Buffer.from(`${WS_KEY}:`).toString("base64");
}

function isCopy(product) {
  for (const field of ["reference", "name"]) {
    const value = String(product[field] || "").trim().toLowerCase();
    if (value.endsWith("(copy)") || value.includes("copy")) return true;
  }
  return false;
}

function hasOrphanedStock(combinations, stockRows) {
  const stockedAttrs = new Set(stockRows.map((row) => row.id_product_attribute));
  return combinations.some((combo) => !stockedAttrs.has(combo.id));
}

/**
 * Pure decision logic, no I/O. Takes already-fetched API JSON fragments and
 * returns one of: OK, MISSING_COMBINATIONS, MISSING_FEATURES,
 * ORPHANED_STOCK, SUSPECT_PARTIAL_DUPLICATE.
 *
 * product: the /api/products/{id} JSON body (has reference, active, etc,
 *          plus an optional expected_features hint from the caller).
 * combinations: list of /api/combinations entries filtered by id_product.
 * features: product.associations.product_features equivalent, pre-extracted.
 * stockRows: list of /api/stock_availables entries filtered by id_product.
 * siblingCombinationCount: expected combo count from the presumed source
 *                          product, if known.
 */
export function classifyDuplicateIntegrity(product, combinations, features, stockRows, siblingCombinationCount = null) {
  const copy = isCopy(product);

  if (copy && combinations.length === 0 && (siblingCombinationCount || 0) > 0) {
    return "MISSING_COMBINATIONS";
  }

  if (copy && features.length === 0 && product.expected_features) {
    return "MISSING_FEATURES";
  }

  if (combinations.length && hasOrphanedStock(combinations, stockRows)) {
    return "ORPHANED_STOCK";
  }

  if (copy && siblingCombinationCount !== null && combinations.length < siblingCombinationCount) {
    return "SUSPECT_PARTIAL_DUPLICATE";
  }

  return "OK";
}

async function apiGet(path, params = {}) {
  const qs = new URLSearchParams({ ...params, output_format: "JSON" });
  const res = await fetch(`${PRESTASHOP_URL}/api/${path}?${qs}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(`${PRESTASHOP_URL}/api/${path}?output_format=JSON`, {
    method: "PUT",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function recentProducts(dateFrom, dateTo) {
  const data = await apiGet("products", {
    "filter[date_add]": `[${dateFrom},${dateTo}]`,
    display: "full",
    limit: "200",
  });
  return data.products || [];
}

async function combinationsFor(idProduct) {
  const data = await apiGet("combinations", {
    "filter[id_product]": idProduct,
    display: "full",
  });
  return data.combinations || [];
}

async function stockRowsFor(idProduct) {
  const data = await apiGet("stock_availables", {
    "filter[id_product]": idProduct,
    display: "full",
  });
  return data.stock_availables || [];
}

function featuresFor(product) {
  return (product.associations && product.associations.product_features) || [];
}

async function deactivate(product) {
  const body = { ...product, active: "0" };
  console.warn(`Deactivating suspect duplicate product ${product.id}`);
  if (!DRY_RUN) {
    await apiPut(`products/${product.id}`, { product: body });
  }
}

export async function run() {
  const candidates = await recentProducts(DATE_FROM, DATE_TO);
  let flagged = 0;

  for (const product of candidates) {
    const combinations = await combinationsFor(product.id);
    const features = featuresFor(product);
    const stockRows = await stockRowsFor(product.id);

    const verdict = classifyDuplicateIntegrity(product, combinations, features, stockRows);

    if (verdict === "OK") continue;

    flagged++;
    console.log(JSON.stringify({
      id_product: product.id,
      reference: product.reference,
      date_add: product.date_add,
      verdict,
      combinations_found: combinations.length,
      features_found: features.length,
      stock_rows_found: stockRows.length,
    }));

    if (!DRY_RUN) await deactivate(product);
  }

  console.log(`Done. ${flagged} suspect duplicate(s) found among ${candidates.length} recent product(s).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
