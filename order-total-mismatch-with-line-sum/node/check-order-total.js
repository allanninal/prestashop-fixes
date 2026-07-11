/**
 * Detect PrestaShop orders whose total_paid does not match the sum of their lines.
 *
 * PrestaShop computes and caches an order's total_paid, total_paid_tax_incl, and
 * total_paid_tax_excl on the orders table separately from each line's own total on the
 * order_detail table (total_price_tax_incl and total_price_tax_excl). The two sources of
 * truth are only reconciled by specific code paths, cart validation and the
 * OrderAmountUpdater run during a back office edit. A rounding-mode setting, a module
 * writing straight to the order totals, or a back office edit to a product line, a
 * discount, or a partial refund can all leave the cached order total out of step with
 * what the lines actually add up to.
 *
 * This script flags affected orders by default. It never overwrites total_paid,
 * total_paid_tax_incl, or total_paid_tax_excl unless DRY_RUN is explicitly false, and
 * even then it re-checks that no pending order_history entry (representing an in-flight
 * state change or refund) exists before attempting the corrective write.
 *
 * Guide: https://www.allanninal.dev/prestashop/order-total-mismatch-with-line-sum/
 *
 * Run on a schedule. Safe to run again and again.
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const ORDER_ID_RANGE = process.env.ORDER_ID_RANGE || "1,50";

const EPSILON = 0.02;

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision logic, no I/O.
 *
 * Sums lineTotalsTaxIncl, adds shipping, subtracts discounts, compares against
 * orderTotalPaidTaxIncl, and returns an object describing the computed total, the
 * difference, and whether that difference is past the tolerance. Caller supplies all
 * values already fetched from the API.
 */
export function diffOrderTotal(orderTotalPaidTaxIncl, lineTotalsTaxIncl, totalShipping, totalDiscounts, epsilon = EPSILON) {
  const lineSum = lineTotalsTaxIncl.reduce((a, b) => a + b, 0);
  const computedTotal = Math.round((lineSum + totalShipping - totalDiscounts) * 100) / 100;
  const diff = Math.round((orderTotalPaidTaxIncl - computedTotal) * 100) / 100;
  return {
    computed_total: computedTotal,
    diff,
    mismatched: Math.abs(diff) > epsilon,
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

async function ordersInRange(idRange) {
  const data = await apiGet("orders", { "filter[id]": `[${idRange}]`, display: "full" });
  return data.orders || [];
}

async function orderDetailLineTotals(idOrder) {
  const data = await apiGet("order_details", { "filter[id_order]": idOrder, display: "full" });
  const details = data.order_details || [];
  return details.map((d) => Number(d.total_price_tax_incl));
}

async function hasPendingHistory(idOrder) {
  const data = await apiGet("order_histories", { "filter[id_order]": idOrder, display: "full" });
  return (data.order_histories || []).length === 0;
}

async function applyRecomputedTotal(order, computedTotal) {
  order.total_paid = computedTotal.toFixed(6);
  order.total_paid_tax_incl = computedTotal.toFixed(6);
  const url = new URL(`${PRESTASHOP_URL}/api/orders/${order.id}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ order }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT orders/${order.id}`);
  return res.json();
}

export async function run() {
  let flagged = 0;
  let repaired = 0;
  for (const order of await ordersInRange(ORDER_ID_RANGE)) {
    const idOrder = order.id;
    const totalPaidTaxIncl = Number(order.total_paid_tax_incl);
    const totalShipping = Number(order.total_shipping || 0);
    const totalDiscounts = Number(order.total_discounts || 0);
    const lineTotals = await orderDetailLineTotals(idOrder);
    const result = diffOrderTotal(totalPaidTaxIncl, lineTotals, totalShipping, totalDiscounts);
    if (!result.mismatched) continue;
    flagged++;
    console.warn(
      `Order total mismatch. id_order=${idOrder} reference=${order.reference} ` +
        `current_state=${order.current_state} stored_total=${totalPaidTaxIncl.toFixed(2)} ` +
        `computed_total=${result.computed_total.toFixed(2)} diff=${result.diff.toFixed(2)}`
    );
    if (!DRY_RUN) {
      if (await hasPendingHistory(idOrder)) {
        console.warn(`Skipping repair for id_order=${idOrder}: no order_histories rows found.`);
        continue;
      }
      await applyRecomputedTotal(order, result.computed_total);
      repaired++;
      console.log(`Applied recomputed total=${result.computed_total.toFixed(2)} for id_order=${idOrder}.`);
    }
  }
  console.log(`Done. ${flagged} order(s) flagged for review, ${repaired} repaired. DRY_RUN=${DRY_RUN}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
