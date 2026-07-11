/**
 * Find and repair PrestaShop order lines whose refunded quantity is stale
 * after a credit slip was created through the webservice.
 *
 * POST /api/order_slip only inserts rows into order_slip and order_slip_detail. It
 * never runs the back office refund logic in OrderSlip::create() or
 * AdminOrdersController, which is what actually recalculates and writes
 * order_detail.product_quantity_refunded, the refund totals, and the related stock
 * movement. So a credit slip can exist while the order line still reports its old
 * refunded quantity.
 *
 * This script sums product_quantity from every order_slip_detail row per
 * id_order_detail to get the expected refunded quantity, compares it against the
 * stored product_quantity_refunded, and only writes the corrected value when
 * DRY_RUN is explicitly false. A negative delta (stored higher than expected) is
 * always flagged for a human, never auto-corrected.
 *
 * Guide: https://www.allanninal.dev/prestashop/api-refund-not-updating-order-line/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const ORDER_IDS = process.env.ORDER_IDS || "1,2,3";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision logic, no I/O.
 *
 * Sums orderSlipQuantities to get the expected refunded quantity, and compares
 * it against storedRefundedQty. needsRepair means the API-created credit slips
 * claim more refunded units than the order line shows. needsReview means the
 * stored value is already higher than the credit slips justify, which is left
 * for a human rather than corrected automatically.
 */
export function computeRefundDelta(storedRefundedQty, orderSlipQuantities) {
  const expected = orderSlipQuantities.reduce((a, b) => a + b, 0);
  const delta = expected - storedRefundedQty;
  return {
    expected,
    stored: storedRefundedQty,
    delta,
    needs_repair: expected > storedRefundedQty,
    needs_review: expected < storedRefundedQty,
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

async function orderSlipsFor(idOrder) {
  const data = await apiGet("order_slip", { "filter[id_order]": idOrder, display: "full" });
  return data.order_slips || [];
}

async function orderDetail(idOrderDetail) {
  const data = await apiGet(`order_details/${idOrderDetail}`, { display: "full" });
  return data.order_detail;
}

async function orderHistoryStates(idOrder) {
  const data = await apiGet("order_histories", { "filter[id_order]": idOrder, display: "full" });
  return (data.order_histories || []).map((h) => h.id_order_state);
}

function refundQuantitiesByLine(orderSlips) {
  const byLine = new Map();
  for (const slip of orderSlips) {
    const details = (slip.associations && slip.associations.order_slip_detail) || slip.order_slip_detail || [];
    for (const row of details) {
      const idOrderDetail = row.id_order_detail;
      if (!byLine.has(idOrderDetail)) byLine.set(idOrderDetail, []);
      byLine.get(idOrderDetail).push(Number(row.product_quantity));
    }
  }
  return byLine;
}

async function applyExpectedRefund(idOrderDetail, expectedQty) {
  const full = (await apiGet(`order_details/${idOrderDetail}`)).order_detail;
  const unitPriceTaxExcl = Number(full.unit_price_tax_excl || 0);
  const unitPriceTaxIncl = Number(full.unit_price_tax_incl || 0);
  full.product_quantity_refunded = expectedQty;
  if ("total_refunded_tax_excl" in full) full.total_refunded_tax_excl = (expectedQty * unitPriceTaxExcl).toFixed(6);
  if ("total_refunded_tax_incl" in full) full.total_refunded_tax_incl = (expectedQty * unitPriceTaxIncl).toFixed(6);
  const url = new URL(`${PRESTASHOP_URL}/api/order_details/${idOrderDetail}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ order_detail: full }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT order_details/${idOrderDetail}`);
  return res.json();
}

export async function run() {
  let checked = 0;
  let repaired = 0;
  let flaggedForReview = 0;
  const orderIds = ORDER_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  for (const idOrder of orderIds) {
    const slips = await orderSlipsFor(idOrder);
    if (!slips.length) continue;
    const byLine = refundQuantitiesByLine(slips);
    const historyStates = await orderHistoryStates(idOrder);
    for (const [idOrderDetail, quantities] of byLine.entries()) {
      const detail = await orderDetail(idOrderDetail);
      const stored = Number(detail.product_quantity_refunded || 0);
      const result = computeRefundDelta(stored, quantities);
      checked++;
      if (result.delta === 0) continue;
      if (result.needs_review) {
        flaggedForReview++;
        console.warn(
          `Needs human review. id_order=${idOrder} id_order_detail=${idOrderDetail} ` +
            `stored=${result.stored} expected=${result.expected} delta=${result.delta}`
        );
        continue;
      }
      if (!historyStates.length) {
        flaggedForReview++;
        console.warn(`Skipping repair, no order_histories rows found. id_order=${idOrder} id_order_detail=${idOrderDetail}`);
        continue;
      }
      console.log(
        `Refund quantity stale. id_order=${idOrder} id_order_detail=${idOrderDetail} ` +
          `stored=${result.stored} expected=${result.expected} ${DRY_RUN ? "would repair" : "repairing"}`
      );
      if (!DRY_RUN) {
        await applyExpectedRefund(idOrderDetail, result.expected);
        const verify = await orderDetail(idOrderDetail);
        console.log(`Verified. id_order_detail=${idOrderDetail} product_quantity_refunded=${verify.product_quantity_refunded}`);
      }
      repaired++;
    }
  }
  console.log(`Done. ${checked} line(s) checked, ${repaired} repaired, ${flaggedForReview} flagged for review. DRY_RUN=${DRY_RUN}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
