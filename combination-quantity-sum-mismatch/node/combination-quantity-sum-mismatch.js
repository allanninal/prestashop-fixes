/**
 * Detect PrestaShop combination stock quantities that do not sum to the product total.
 *
 * stock_available keeps one row per (id_product, id_product_attribute, id_shop). The row
 * where id_product_attribute is 0 is the product-level quantity, and it is only kept equal
 * to the sum of the combination rows by application code such as StockAvailable::synchronizeOne,
 * never by a live SUM() or a database constraint. Deleting and recreating combinations, direct
 * SQL or ERP writes, and advanced stock management setups can all leave the two figures
 * disagreeing. This reports the mismatch and any orphaned stock rows left behind by deleted
 * combinations. It never writes a combination row, and it only writes the product-level row
 * when a mismatch is confirmed and DRY_RUN is off. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/prestashop/combination-quantity-sum-mismatch/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = (process.env.PRESTASHOP_URL || "https://example.test").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "dummy_key";
const SHOP_ID = Number(process.env.PRESTASHOP_SHOP_ID || 1);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

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

async function combinationsForProduct(idProduct) {
  const data = await apiGet("combinations", { display: "full", "filter[id_product]": idProduct });
  const rows = data.combinations || [];
  return rows.map((c) => ({ id: Number(c.id), id_product: Number(c.id_product) }));
}

async function stockRowsForProduct(idProduct) {
  const data = await apiGet("stock_availables", { display: "full", "filter[id_product]": idProduct });
  const rows = data.stock_availables || [];
  return rows.map((r) => ({
    id: Number(r.id),
    id_product: Number(r.id_product),
    id_product_attribute: Number(r.id_product_attribute || 0),
    id_shop: Number(r.id_shop || 0),
    quantity: Number(r.quantity || 0),
  }));
}

// Pure decision function. No network or DB calls. See the guide for the full spec.
export function findStockMismatches(productId, combinations, stockAvailableRows, shopId) {
  const rows = stockAvailableRows.filter(
    (r) => r.id_shop === shopId && r.id_product === productId
  );
  const validAttributeIds = new Set(combinations.map((c) => c.id));

  const productRow = rows.find((r) => r.id_product_attribute === 0);
  const productLevelQuantity = productRow ? productRow.quantity : null;

  const combinationRows = rows.filter((r) => r.id_product_attribute !== 0);
  const orphanedRowIds = combinationRows
    .filter((r) => !validAttributeIds.has(r.id_product_attribute))
    .map((r) => r.id);
  const validCombinationRows = combinationRows.filter((r) =>
    validAttributeIds.has(r.id_product_attribute)
  );
  const combinationQuantitySum = validCombinationRows.reduce((sum, r) => sum + r.quantity, 0);

  const delta = (productLevelQuantity ?? 0) - combinationQuantitySum;
  const isMismatched = combinations.length > 0 && delta !== 0;

  return {
    productId,
    productLevelQuantity,
    combinationQuantitySum,
    delta,
    isMismatched,
    orphanedRowIds,
  };
}

async function correctProductLevelQuantity(productRowId, combinationQuantitySum) {
  const url = new URL(`${BASE_URL}/api/stock_availables/${productRowId}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ stock_available: { id: productRowId, quantity: combinationQuantitySum } }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function checkProduct(productId, shopId = SHOP_ID) {
  const combinations = await combinationsForProduct(productId);
  const rows = await stockRowsForProduct(productId);
  return [findStockMismatches(productId, combinations, rows, shopId), rows];
}

export async function run(productIds) {
  let mismatchedCount = 0;
  let orphanCount = 0;
  for (const productId of productIds) {
    const [report, rows] = await checkProduct(productId);

    if (report.orphanedRowIds.length) {
      orphanCount += report.orphanedRowIds.length;
      console.warn(
        `Product ${productId} has ${report.orphanedRowIds.length} orphaned stock_available row(s): ${report.orphanedRowIds} (manual review only)`
      );
    }

    if (!report.isMismatched) continue;
    mismatchedCount++;
    console.warn(
      `Product ${productId} mismatch: product_level=${report.productLevelQuantity} combination_sum=${report.combinationQuantitySum} delta=${report.delta} (${DRY_RUN ? "would correct" : "correcting"})`
    );
    if (!DRY_RUN) {
      const productRow = rows.find((r) => r.id_product_attribute === 0);
      await correctProductLevelQuantity(productRow.id, report.combinationQuantitySum);
    }
  }
  console.log(`Done. ${mismatchedCount} product(s) mismatched, ${orphanCount} orphaned row(s) found.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ids = (process.env.PRODUCT_IDS || "").split(",").map((x) => x.trim()).filter(Boolean).map(Number);
  run(ids).catch((err) => { console.error(err); process.exit(1); });
}
