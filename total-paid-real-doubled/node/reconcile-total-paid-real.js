/**
 * Detect PrestaShop orders whose total_paid_real has doubled after a duplicate payment.
 *
 * Order::addOrderPayment() both inserts a row into order_payment and directly increments
 * the order's own total_paid_real column before saving the order. Nothing checks whether
 * a matching payment already exists, so a partial-payment workflow that triggers this
 * method twice for the same real-world payment, for example an auto-added payment from
 * Order::validateOrder() plus a separate order_history update or a payment module call,
 * leaves order_payment with a duplicate row and total_paid_real incremented twice. The
 * stored total can end up exactly double the true sum of the real payment rows.
 *
 * This script flags affected orders by default. It never rewrites total_paid_real on
 * its own, since order_payment is the source of truth and the cached total is only
 * derived from it. A confirmed repair deletes the specific duplicate order_payment row,
 * then PUTs the order with total_paid_real recomputed from the remaining rows, only when
 * DRY_RUN is false and the operator has supplied the confirmed duplicate payment id.
 *
 * Guide: https://www.allanninal.dev/prestashop/total-paid-real-doubled/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const CONFIRM_DUPLICATE_PAYMENT_ID = process.env.CONFIRM_DUPLICATE_PAYMENT_ID || "";
const ORDER_IDS = (process.env.ORDER_IDS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean)
  .map(Number);

const EPSILON = 0.01;

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * Sums orderPaymentAmounts and compares that sum to orderTotalPaidReal within epsilon.
 * mismatch is true when they disagree past the tolerance. likelyDoubled is true when
 * orderTotalPaidReal is within epsilon of twice the real sum (or twice totalPaid when
 * there are no payment rows yet), which is the signature shape of the duplicate
 * addOrderPayment() bug rather than an ordinary partial-payment shortfall.
 */
export function reconcilePayment(orderTotalPaidReal, orderPaymentAmounts, totalPaid = null, epsilon = EPSILON) {
  const sumPayments = Math.round(orderPaymentAmounts.reduce((a, b) => a + b, 0) * 100) / 100;
  const mismatch = Math.abs(orderTotalPaidReal - sumPayments) > epsilon;
  const baseline = sumPayments > epsilon ? sumPayments : (totalPaid || 0);
  const likelyDoubled = baseline > epsilon && Math.abs(orderTotalPaidReal - 2 * baseline) <= epsilon;
  return {
    mismatch,
    sumPayments,
    delta: Math.round((orderTotalPaidReal - sumPayments) * 100) / 100,
    likelyDoubled,
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

async function getOrder(idOrder) {
  const data = await apiGet(`orders/${idOrder}`);
  return data.order;
}

async function orderPaymentsForReference(reference) {
  const data = await apiGet("order_payments", {
    "filter[order_reference]": reference,
    display: "full",
  });
  let payments = data.order_payments || [];
  if (!Array.isArray(payments)) payments = [payments];
  return payments;
}

async function deleteOrderPayment(idOrderPayment) {
  const res = await fetch(`${PRESTASHOP_URL}/api/order_payments/${idOrderPayment}`, {
    method: "DELETE",
    headers: { Authorization: basicAuthHeader() },
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on DELETE order_payments/${idOrderPayment}`);
}

async function putCorrectedTotal(order, correctedTotalPaidReal) {
  const url = new URL(`${PRESTASHOP_URL}/api/orders/${order.id}`);
  url.searchParams.set("output_format", "JSON");
  const body = { order: { ...order, total_paid_real: correctedTotalPaidReal.toFixed(2) } };
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT orders/${order.id}`);
  return res.json();
}

export async function run() {
  let flagged = 0;
  let repaired = 0;
  for (const idOrder of ORDER_IDS) {
    const order = await getOrder(idOrder);
    const reference = order.reference;
    const totalPaid = Number(order.total_paid);
    const totalPaidReal = Number(order.total_paid_real);
    const payments = await orderPaymentsForReference(reference);
    const amounts = payments.map((p) => Number(p.amount));
    const result = reconcilePayment(totalPaidReal, amounts, totalPaid);
    if (!result.mismatch) continue;
    flagged++;
    const doubledNote = result.likelyDoubled ? " (looks doubled, likely a duplicate addOrderPayment call)" : "";
    console.warn(
      `Order has a payment mismatch. id_order=${idOrder} reference=${reference} ` +
        `total_paid=${totalPaid.toFixed(2)} total_paid_real=${totalPaidReal.toFixed(2)} ` +
        `sum_order_payments=${result.sumPayments.toFixed(2)} delta=${result.delta.toFixed(2)}${doubledNote}`
    );
    if (!DRY_RUN && CONFIRM_DUPLICATE_PAYMENT_ID) {
      await deleteOrderPayment(CONFIRM_DUPLICATE_PAYMENT_ID);
      const remaining = payments
        .filter((p) => String(p.id) !== String(CONFIRM_DUPLICATE_PAYMENT_ID))
        .map((p) => Number(p.amount));
      const correctedTotal = Math.round(remaining.reduce((a, b) => a + b, 0) * 100) / 100;
      await putCorrectedTotal(order, correctedTotal);
      repaired++;
      console.log(
        `Deleted duplicate order_payment id=${CONFIRM_DUPLICATE_PAYMENT_ID} and set total_paid_real=${correctedTotal.toFixed(2)} for id_order=${idOrder}.`
      );
    }
  }
  console.log(`Done. ${flagged} order(s) flagged for review, ${repaired} repaired. DRY_RUN=${DRY_RUN}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
