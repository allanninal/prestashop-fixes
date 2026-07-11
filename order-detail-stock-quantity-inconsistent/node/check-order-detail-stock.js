/**
 * Detect PrestaShop order_detail rows where the stock snapshot disagrees with the order.
 *
 * Every order_detail row carries product_quantity, what was actually ordered, and
 * product_quantity_in_stock, a snapshot computed separately at order-save time by
 * Product::getQuantity() and the stock logic, meant to record whether the item was in
 * stock when ordered. Because product_quantity_in_stock is computed rather than copied
 * from product_quantity, regressions in that computation (see PrestaShop GitHub issue
 * #16840) and edge cases like disabled stock management, advanced stock management,
 * backorders, or partial refunds can leave product_quantity_in_stock at 0 while
 * product_quantity still shows the real ordered amount on the same row.
 *
 * This script never writes to order_details. product_quantity_in_stock is a historical
 * snapshot tied to real stock events at order time, so rewriting it automatically can
 * hide a genuine backorder or oversell event and corrupt the audit trail. It only detects
 * inconsistent rows and emits a report line for a human to review. A confirmed fix is a
 * targeted, manual PUT to order_details/{id} correcting product_quantity_in_stock alone,
 * never a bulk automated write.
 *
 * Guide: https://www.allanninal.dev/prestashop/order-detail-stock-quantity-inconsistent/
 *
 * Run on a schedule. Safe to run again and again.
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const ORDER_DATE_FROM = process.env.ORDER_DATE_FROM || "";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 * Returns true when productQuantity is positive and productQuantityInStock does not
 * equal productQuantity minus productQuantityRefunded, i.e. the in-stock snapshot
 * disagrees with the net ordered quantity for that line.
 */
export function isStockQuantityInconsistent(productQuantity, productQuantityInStock, productQuantityRefunded = 0) {
  if (productQuantity <= 0) return false;
  return productQuantityInStock !== (productQuantity - productQuantityRefunded);
}

function buildReportRow(orderDetail, idOrder) {
  return {
    id_order: idOrder,
    id_order_detail: orderDetail.id,
    product_id: orderDetail.product_id,
    product_quantity: Number(orderDetail.product_quantity || 0),
    product_quantity_in_stock: Number(orderDetail.product_quantity_in_stock || 0),
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

async function recentOrderIds(dateFrom) {
  const params = { display: "full" };
  if (dateFrom) params["filter[date_add]"] = `${dateFrom},`;
  const data = await apiGet("orders", params);
  const orders = data.orders || [];
  return orders.map((o) => o.id);
}

async function orderDetailLines(idOrder) {
  const data = await apiGet("order_details", { "filter[id_order]": idOrder, display: "full" });
  return data.order_details || [];
}

export async function run(dateFrom = ORDER_DATE_FROM) {
  let flagged = 0;
  for (const idOrder of await recentOrderIds(dateFrom)) {
    for (const line of await orderDetailLines(idOrder)) {
      const productQuantity = Number(line.product_quantity || 0);
      const productQuantityInStock = Number(line.product_quantity_in_stock || 0);
      const productQuantityRefunded = Number(line.product_quantity_refunded || 0);
      if (!isStockQuantityInconsistent(productQuantity, productQuantityInStock, productQuantityRefunded)) continue;
      const row = buildReportRow(line, idOrder);
      flagged++;
      console.warn(
        `Inconsistent order_detail. id_order=${row.id_order} id_order_detail=${row.id_order_detail} ` +
          `product_id=${row.product_id} product_quantity=${row.product_quantity} ` +
          `product_quantity_in_stock=${row.product_quantity_in_stock} product_quantity_refunded=${productQuantityRefunded}`
      );
    }
  }
  console.log(
    `Done. ${flagged} order_detail row(s) flagged for review. DRY_RUN=${DRY_RUN} (this script never writes to order_details).`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
