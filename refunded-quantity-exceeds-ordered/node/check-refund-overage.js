/**
 * Detect PrestaShop order_detail rows where the refunded quantity exceeds the
 * ordered quantity.
 *
 * PrestaShop stores product_quantity and product_quantity_refunded as independent
 * unsigned columns on order_detail. Standard and partial refunds, issued through
 * IssueStandardRefundCommand or IssuePartialRefundCommand, increment
 * product_quantity_refunded without ever adjusting product_quantity, and nothing
 * in the back office validates that the refunded count stays under the ordered
 * count. If a line's quantity is later edited down by hand, or repeated partial
 * refunds keep stacking against the same line outside the normal flow,
 * product_quantity_refunded can end up bigger than product_quantity. Per
 * PrestaShop/PrestaShop#39391 this can later throw SQLSTATE[22003]: 1690 BIGINT
 * UNSIGNED value is out of range in 'product_quantity - product_quantity_refunded'
 * when core code computes that subtraction for stock or shippable-quantity checks.
 *
 * This script flags affected lines by default. It never overwrites
 * product_quantity_refunded unless DRY_RUN is explicitly false and the order id
 * is in an operator-confirmed CONFIRM_ORDER_IDS list, and even then it only
 * clamps product_quantity_refunded down to product_quantity, re-sending the full
 * order_detail resource body as PrestaShop's webservice requires on a PUT.
 *
 * Guide: https://www.allanninal.dev/prestashop/refunded-quantity-exceeds-ordered/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const DATE_FROM = process.env.DATE_FROM || "2026-06-01";
const DATE_TO = process.env.DATE_TO || "2026-07-11";
const CONFIRM_ORDER_IDS = new Set(
  (process.env.CONFIRM_ORDER_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number)
);

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision logic, no I/O.
 *
 * Input: a list of order_detail objects already fetched from the API, each with
 * keys id, id_order, product_id, product_quantity (int), product_quantity_refunded
 * (int), product_quantity_return (int), product_quantity_reinjected (int).
 *
 * For each line, computes delta = product_quantity_refunded - product_quantity; a
 * positive delta is a finding tagged refunded_exceeds_ordered. Also flags,
 * separately tagged, lines where product_quantity_return exceeds
 * product_quantity (returned_exceeds_ordered) or product_quantity_reinjected
 * exceeds product_quantity_refunded (reinjected_exceeds_refunded).
 *
 * Returns findings sorted by overage descending.
 */
export function findRefundOverage(orderLines) {
  const findings = [];
  for (const line of orderLines) {
    const ordered = Number(line.product_quantity);
    const refunded = Number(line.product_quantity_refunded);
    const returned = Number(line.product_quantity_return || 0);
    const reinjected = Number(line.product_quantity_reinjected || 0);
    const delta = refunded - ordered;
    if (delta > 0) {
      findings.push({
        id_order: line.id_order,
        id: line.id,
        product_id: line.product_id,
        ordered,
        refunded,
        overage: delta,
        reason: "refunded_exceeds_ordered",
      });
    }
    if (returned > ordered) {
      findings.push({
        id_order: line.id_order,
        id: line.id,
        product_id: line.product_id,
        ordered,
        refunded: returned,
        overage: returned - ordered,
        reason: "returned_exceeds_ordered",
      });
    }
    if (reinjected > refunded) {
      findings.push({
        id_order: line.id_order,
        id: line.id,
        product_id: line.product_id,
        ordered: refunded,
        refunded: reinjected,
        overage: reinjected - refunded,
        reason: "reinjected_exceeds_refunded",
      });
    }
  }
  return findings.sort((a, b) => b.overage - a.overage);
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function recentOrderIds(dateFrom, dateTo) {
  const data = await apiGet("orders", { "filter[date_add]": `[${dateFrom},${dateTo}]`, display: "full" });
  return (data.orders || []).map((o) => Number(o.id));
}

async function orderLines(idOrder) {
  const data = await apiGet("order_details", { "filter[id_order]": idOrder, display: "full" });
  return data.order_details || [];
}

async function orderSlipsFor(idOrder) {
  const data = await apiGet("order_slips", { "filter[id_order]": idOrder, display: "full" });
  return data.order_slips || [];
}

async function clampRefundedToOrdered(orderDetailId) {
  const full = (await apiGet(`order_details/${orderDetailId}`)).order_detail;
  full.product_quantity_refunded = full.product_quantity;
  const url = new URL(`${PRESTASHOP_URL}/api/order_details/${orderDetailId}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ order_detail: full }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT order_details/${orderDetailId}`);
  return res.json();
}

export async function run() {
  let flagged = 0;
  let repaired = 0;
  for (const idOrder of await recentOrderIds(DATE_FROM, DATE_TO)) {
    const lines = await orderLines(idOrder);
    const findings = findRefundOverage(lines);
    if (!findings.length) continue;
    const slips = await orderSlipsFor(idOrder);
    for (const finding of findings) {
      flagged++;
      console.warn(
        `Refund overage. id_order=${finding.id_order} id=${finding.id} ` +
          `product_id=${finding.product_id} ordered=${finding.ordered} ` +
          `refunded=${finding.refunded} overage=${finding.overage} ` +
          `reason=${finding.reason} credit_slips=${slips.length}`
      );
      if (!DRY_RUN && finding.reason === "refunded_exceeds_ordered" && CONFIRM_ORDER_IDS.has(idOrder)) {
        await clampRefundedToOrdered(finding.id);
        repaired++;
        console.log(`Clamped order_detail id=${finding.id} refunded down to ordered=${finding.ordered}.`);
      }
    }
  }
  console.log(`Done. ${flagged} line(s) flagged for review, ${repaired} repaired. DRY_RUN=${DRY_RUN}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
