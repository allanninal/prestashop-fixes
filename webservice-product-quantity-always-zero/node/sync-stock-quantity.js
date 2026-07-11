/**
 * Detect and repair PrestaShop products whose webservice quantity is stuck at zero.
 *
 * Since PrestaShop 1.5, physical stock lives in stock_availables, keyed by id_product
 * (and id_product_attribute for combinations), not in the products table. The webservice
 * products resource still exposes a legacy quantity field for backward compatibility, but
 * it was never wired to stock_availables.quantity, so GET always returns 0 and PUT/POST
 * silently no-op on it (PrestaShop/PrestaShop GitHub issue #18953).
 *
 * This script lists products, ignores their bogus quantity field entirely, fetches the
 * real stock_availables row for each one, and flags active, visible products whose real
 * quantity is unexpectedly zero or negative. The only sanctioned write (when DRY_RUN=false
 * and a target quantity is known) is a PATCH to the specific stock_availables/{id}
 * resource. products.quantity is never written; it is a no-op field. Ambiguous cases are
 * reported for human reconciliation rather than auto-corrected.
 *
 * Guide: https://www.allanninal.dev/prestashop/webservice-product-quantity-always-zero/
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
 * productQuantityField: the legacy products.quantity value (always 0, never trusted).
 * stockAvailableQuantity: the real quantity from stock_availables, or null if no row.
 * isActive, visibility: the product's active flag and visibility ("both"/"catalog"/
 *   "search"/"none").
 * dryRun: whether writes are currently disabled.
 * expectedPositive: caller's signal that this product should currently have stock.
 * targetQuantity: the corrected quantity to write, if known.
 *
 * Returns a decision object describing what to do. All HTTP calls happen in the caller.
 */
export function decideQuantitySync(
  productQuantityField, stockAvailableQuantity, isActive, visibility, dryRun,
  expectedPositive = false, targetQuantity = null
) {
  // products.quantity is a legacy, unwired field and is never the comparison source.
  void productQuantityField;

  if (stockAvailableQuantity == null) {
    return {
      status: "ignore_legacy_field",
      action: "flag",
      reason: "no stock_availables row found for this product",
      targetQuantity: null,
    };
  }

  const needsRepair = isActive && visibility !== "none"
    && stockAvailableQuantity <= 0 && expectedPositive;

  if (!needsRepair) {
    return {
      status: "ignore_legacy_field",
      action: "none",
      reason: "real stock_availables quantity looks fine",
      targetQuantity: null,
    };
  }

  const dryRunSafeToWrite = !dryRun && targetQuantity !== null;
  if (dryRunSafeToWrite) {
    return {
      status: "ignore_legacy_field",
      action: "patch_stock_available",
      reason: "active, visible product has non-positive real stock",
      targetQuantity,
    };
  }

  return {
    status: "ignore_legacy_field",
    action: "flag",
    reason: "discrepancy needs human reconciliation before any write",
    targetQuantity,
  };
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function apiPatch(path, resourceKey, body) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ [resourceKey]: body }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PATCH ${path}`);
  return res.json();
}

async function listProducts(limit = 100) {
  const data = await apiGet("products", { display: "full", limit });
  return data.products || [];
}

async function stockAvailableRow(idProduct, idProductAttribute = 0) {
  const data = await apiGet("stock_availables", {
    "filter[id_product]": idProduct,
    "filter[id_product_attribute]": idProductAttribute,
    display: "full",
  });
  const rows = data.stock_availables || [];
  return rows.length ? rows[0] : null;
}

async function repairStockAvailable(idStockAvailable, idProduct, idProductAttribute, targetQuantity) {
  const body = {
    id: idStockAvailable,
    id_product: idProduct,
    id_product_attribute: idProductAttribute,
    quantity: targetQuantity,
  };
  return apiPatch(`stock_availables/${idStockAvailable}`, "stock_available", body);
}

export async function run() {
  let flagged = 0;
  let repaired = 0;
  for (const product of await listProducts()) {
    const idProduct = product.id;
    const isActive = String(product.active) === "1";
    const visibility = product.visibility || "both";
    const legacyQuantity = product.quantity;

    const row = await stockAvailableRow(idProduct);
    const realQuantity = row ? Number(row.quantity) : null;

    const decision = decideQuantitySync(legacyQuantity, realQuantity, isActive, visibility, DRY_RUN);

    if (decision.action === "none") continue;

    flagged++;
    console.warn(
      `Product ${idProduct} id_stock_available=${row ? row.id : null} legacy products.quantity=${legacyQuantity} (ignored) ` +
        `real stock_availables.quantity=${realQuantity} action=${decision.action} reason=${decision.reason}`
    );

    if (decision.action === "patch_stock_available" && row && !DRY_RUN) {
      await repairStockAvailable(row.id, idProduct, row.id_product_attribute || 0, decision.targetQuantity);
      repaired++;
      console.log(`Patched stock_availables/${row.id} quantity=${decision.targetQuantity}.`);
    }
  }
  console.log(`Done. ${flagged} row(s) flagged, ${repaired} repaired.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
