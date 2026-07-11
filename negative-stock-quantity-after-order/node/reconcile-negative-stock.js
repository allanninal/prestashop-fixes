/**
 * Find PrestaShop stock_available rows that went negative from an out of stock order,
 * and safely clamp only the true defects back to zero.
 *
 * Root cause: PrestaShop lets a product be sold with zero stock whenever out_of_stock
 * allows ordering (0=deny, 1=allow/backorder, 2=use the global PS_ORDER_OUT_OF_STOCK
 * default), or when depends_on_stock is 0 for a pack or virtual product. When the
 * order is validated, StockAvailable::updateQuantity() subtracts the ordered amount
 * from ps_stock_available.quantity unconditionally, without checking whether stock is
 * already at zero, so quantity can go negative.
 *
 * A negative quantity on a pack or virtual product (depends_on_stock = 0) is expected
 * and benign, since that row is not really stock-tracked. Only rows with
 * depends_on_stock = 1, a simple product that is supposed to be stock-tracked, are a
 * real oversell defect.
 *
 * This script is a Reconciler, not an auto fixer: DRY_RUN defaults to true and only
 * reports. When DRY_RUN is false and an operator has confirmed the list, it clamps
 * only the quantity field to 0 on the flagged rows, and logs the old and new quantity
 * for every change. It never touches out_of_stock or depends_on_stock. Safe to run
 * again and again.
 *
 * Guide: https://www.allanninal.dev/prestashop/negative-stock-quantity-after-order/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision logic, no I/O.
 *
 * Returns { needsFix, newQuantity, reason }.
 *
 * - quantity >= 0                          -> needsFix=false, reason='not negative'
 * - depends_on_stock !== 1 (and negative)   -> needsFix=false, benign pack/virtual row
 * - quantity < 0 and dependsOnStock === 1   -> needsFix=true, newQuantity is 0 unless
 *   dryRun, in which case it is null (nothing is written yet).
 */
export function decideStockReconciliation(quantity, dependsOnStock, outOfStock, dryRun) {
  if (quantity >= 0) {
    return { needsFix: false, newQuantity: null, reason: "not negative" };
  }
  if (dependsOnStock !== 1) {
    return {
      needsFix: false,
      newQuantity: null,
      reason: "not stock-tracked (pack/virtual/depends_on_stock=0), negative value expected/benign",
    };
  }
  return {
    needsFix: true,
    newQuantity: dryRun ? null : 0,
    reason: "negative tracked stock from oversell; clamp to zero",
  };
}

function authHeader() {
  return "Basic " + Buffer.from(`${WS_KEY}:`).toString("base64");
}

async function apiGet(path, params = {}) {
  const qs = new URLSearchParams({ ...params, output_format: "JSON" });
  const res = await fetch(`${BASE_URL}/api/${path}?${qs}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(`${BASE_URL}/api/${path}?output_format=JSON`, {
    method: "PUT",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function negativeStockRows() {
  const data = await apiGet("stock_availables", {
    display: "full",
    "filter[quantity]": "[-1000,-1]",
  });
  let rows = data.stock_availables || [];
  if (rows.length === 0) {
    const page = await apiGet("stock_availables", { display: "full", limit: "0,1000" });
    rows = (page.stock_availables || []).filter((r) => Number(r.quantity) < 0);
  }
  return rows;
}

async function clampToZero(row) {
  const body = {
    stock_available: {
      id: row.id,
      id_product: row.id_product,
      id_product_attribute: row.id_product_attribute,
      quantity: 0,
      depends_on_stock: row.depends_on_stock,
      out_of_stock: row.out_of_stock,
    },
  };
  return apiPut(`stock_availables/${row.id}`, body);
}

export async function run() {
  let flagged = 0;
  const rows = await negativeStockRows();
  for (const row of rows) {
    const quantity = Number(row.quantity || 0);
    const dependsOnStock = Number(row.depends_on_stock || 0);
    const outOfStock = Number(row.out_of_stock || 0);
    const decision = decideStockReconciliation(quantity, dependsOnStock, outOfStock, DRY_RUN);
    if (!decision.needsFix) continue;
    const oldQuantity = quantity;
    console.warn(
      `stock_available ${row.id} (product ${row.id_product}) quantity=${oldQuantity} -> ${DRY_RUN ? "0 (dry run)" : 0}. ${decision.reason}`
    );
    if (!DRY_RUN) {
      await clampToZero(row);
      console.log(`stock_available ${row.id} fixed: ${oldQuantity} -> 0`);
    }
    flagged++;
  }
  console.log(`Done. ${flagged} row(s) ${DRY_RUN ? "to clamp" : "clamped to zero"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
