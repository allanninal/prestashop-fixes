/**
 * Find PrestaShop orders that reached a paid state despite the product being out of stock.
 *
 * PrestaShop checks stock when an item is added to the cart, but never re-verifies
 * stock_available against the cart at the final checkout step or inside a payment
 * module's validateOrder() callback. If stock is depleted by a concurrent order, or a
 * module writes a paid state directly, the order ends up paid while the product's
 * out_of_stock policy denies backorders and quantity is 0 or lower.
 *
 * This script only reports. The optional, DRY_RUN-guarded corrective step only ever adds
 * an order_histories entry to an existing, human-approved review state; it never edits
 * orders.current_state directly and never invents a new paid or unpaid transition.
 * Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/prestashop/paid-order-despite-out-of-stock-product/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const AUDIT_WINDOW_DAYS = Number(process.env.AUDIT_WINDOW_DAYS || 30);
const REVIEW_STATE_ID = process.env.REVIEW_STATE_ID; // human-approved id_order_state, optional

/**
 * Pure decision function. No I/O.
 *
 * orderLines: [{ productId, productAttributeId, productQuantity }]
 * stockByLineKey: Map<"productId:productAttributeId", { quantity, outOfStock }>
 */
export function decideOutOfStockPaidFlag({ orderId, currentStateId, paidStateIds, orderLines, stockByLineKey }) {
  const isPaid = paidStateIds.includes(currentStateId);
  if (!isPaid) return { flagged: false, reasons: [] };

  const reasons = [];
  for (const line of orderLines) {
    const key = `${line.productId}:${line.productAttributeId}`;
    const stock = stockByLineKey.get(key);
    if (!stock) continue;
    const denyBackorder = stock.outOfStock === 0;
    const insufficient = stock.quantity < line.productQuantity || stock.quantity <= 0;
    if (denyBackorder && insufficient) {
      reasons.push(`line ${key}: qty ${stock.quantity} < needed ${line.productQuantity}, backorders denied`);
    }
  }

  return { flagged: reasons.length > 0, reasons };
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

async function apiPost(path, body) {
  const res = await fetch(`${BASE_URL}/api/${path}?output_format=JSON`, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function paidStateIds() {
  const data = await apiGet("order_states", { "filter[paid]": "1", display: "full" });
  const states = data.order_states || [];
  return states.map((s) => Number(s.id));
}

async function paidOrders(paidIds, dateFrom, dateTo) {
  const idsFilter = "[" + paidIds.join("|") + "]";
  const data = await apiGet("orders", {
    "filter[current_state]": idsFilter,
    display: "full",
    date: "1",
    "filter[date_add]": `[${dateFrom},${dateTo}]`,
  });
  return data.orders || [];
}

async function orderLines(orderId) {
  const data = await apiGet("order_details", { "filter[id_order]": orderId, display: "full" });
  const rows = data.order_details || [];
  return rows.map((r) => ({
    productId: Number(r.product_id),
    productAttributeId: Number(r.product_attribute_id || 0),
    productQuantity: Number(r.product_quantity),
  }));
}

async function stockForLine(productId, productAttributeId) {
  const data = await apiGet("stock_availables", {
    "filter[id_product]": productId,
    "filter[id_product_attribute]": productAttributeId,
    display: "full",
  });
  const rows = data.stock_availables || [];
  if (rows.length === 0) return null;
  const row = rows[0];
  return { quantity: Number(row.quantity), outOfStock: Number(row.out_of_stock) };
}

async function postReviewHistory(orderId, reviewStateId) {
  const body = { order_history: { id_order: orderId, id_order_state: reviewStateId } };
  if (DRY_RUN || !reviewStateId) {
    console.log(`Dry run (or no review_state_id): would POST order_histories`, body);
    return null;
  }
  return apiPost("order_histories", body);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

export async function run() {
  const paidIds = await paidStateIds();
  const now = new Date();
  const dateTo = isoDate(now);
  const dateFrom = isoDate(new Date(now.getTime() - AUDIT_WINDOW_DAYS * 86400 * 1000));

  let flagged = 0;
  const orders = await paidOrders(paidIds, dateFrom, dateTo);
  for (const order of orders) {
    const orderId = Number(order.id);
    const currentStateId = Number(order.current_state);
    const lines = await orderLines(orderId);
    const stockByLineKey = new Map();
    for (const line of lines) {
      const key = `${line.productId}:${line.productAttributeId}`;
      const stock = await stockForLine(line.productId, line.productAttributeId);
      if (stock) stockByLineKey.set(key, stock);
    }

    const decision = decideOutOfStockPaidFlag({
      orderId,
      currentStateId,
      paidStateIds: paidIds,
      orderLines: lines,
      stockByLineKey,
    });
    if (!decision.flagged) continue;

    for (const reason of decision.reasons) {
      console.warn(`Order ${orderId} flagged: ${reason}`);
    }
    if (REVIEW_STATE_ID) {
      await postReviewHistory(orderId, Number(REVIEW_STATE_ID));
    }
    flagged++;
  }

  console.log(`Done. ${flagged} order(s) flagged for paid-despite-out-of-stock.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
