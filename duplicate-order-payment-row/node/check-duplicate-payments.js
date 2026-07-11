/**
 * Detect PrestaShop orders with a duplicated order_payment row.
 *
 * When an order state has both Consider the associated order as validated and Set the
 * order as paid enabled together, such as a typical bankwire or cheque Payment accepted
 * status, Order::validateOrder() with that state triggers two independent code paths
 * that each write a payment for the same amount. PaymentModule::validateOrder() calls
 * Order::addOrderPayment() directly, while the invoice-generation path in OrderInvoice
 * (getRestPaid() / getTotalPaid()) still treats the order as owing money on a dummy
 * invoice (invoice number 0) and lets the state-change logic re-trigger a second
 * payment insert. Both writes land in order_payment with the identical id_order and
 * amount. Tracked upstream as PrestaShop/PrestaShop issue #12588 and only fully patched
 * in pull request #19260 (PrestaShop 1.7.8.0) by making OrderInvoice::getRestPaid()
 * return 0 for invoices whose number is still 0.
 *
 * This script only reads and reports. The order_payment resource has no DELETE route in
 * the core webservice, and removing the wrong row by hand risks corrupting
 * total_paid_real, so it never writes or deletes anything. Flagged orders need a store
 * admin to review and remove the extra row in Back Office > Orders, or via a backed up
 * direct database delete plus a recalculation of total_paid_real.
 *
 * Guide: https://www.allanninal.dev/prestashop/duplicate-order-payment-row/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const PAID_AND_LOGABLE_STATE_ID = process.env.PAID_AND_LOGABLE_STATE_ID || "";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

function toEpoch(dateAdd) {
  return Date.parse(String(dateAdd).replace(" ", "T")) / 1000;
}

/**
 * Pure decision function, no I/O.
 *
 * payments is an array of order_payments rows already fetched for one order, each with
 * at least order_reference, amount, and date_add. Sorts by date_add, then scans
 * adjacent pairs, grouping any pair whose amounts match within amountTolerance and
 * whose date_add values are within timeToleranceSeconds of each other. Returns an
 * array of cluster objects for clusters of size 2 or more.
 */
export function findDuplicatePayments(payments, amountTolerance = 0.01, timeToleranceSeconds = 60) {
  const rows = [...payments].sort((a, b) => toEpoch(a.date_add) - toEpoch(b.date_add));
  const clusters = [];
  const used = new Set();
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    if (used.has(a) && used.has(b)) continue;
    const amountA = Number(a.amount);
    const amountB = Number(b.amount);
    const deltaSeconds = Math.abs(toEpoch(b.date_add) - toEpoch(a.date_add));
    if (Math.abs(amountA - amountB) <= amountTolerance && deltaSeconds <= timeToleranceSeconds) {
      clusters.push({
        order_reference: a.order_reference,
        duplicate_payment_ids: [a.id, b.id],
        amount: amountA,
        count: 2,
      });
      used.add(a);
      used.add(b);
    }
  }
  return clusters;
}

export function buildReportRow(idOrder, orderReference, cluster, paidReal) {
  const summed = cluster.amount * cluster.count;
  return {
    id_order: idOrder,
    order_reference: orderReference,
    duplicate_payment_ids: cluster.duplicate_payment_ids,
    amount: cluster.amount,
    summed_order_payments: Math.round(summed * 100) / 100,
    total_paid_real: paidReal,
    inflated: Math.round(summed * 100) / 100 !== Math.round(paidReal * 100) / 100,
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

async function isPaidAndLogableState(idState) {
  const data = await apiGet(`order_states/${idState}`, { display: "full" });
  const state = data.order_state || {};
  return String(state.paid) === "1" && String(state.logable) === "1";
}

async function ordersInState(idState) {
  const data = await apiGet("orders", { "filter[current_state]": idState, display: "full" });
  return data.orders || [];
}

async function orderPaymentsFor(orderReference) {
  const data = await apiGet("order_payments", {
    "filter[order_reference]": orderReference,
    display: "full",
  });
  return data.order_payments || [];
}

async function totalPaidReal(idOrder) {
  const data = await apiGet(`orders/${idOrder}`, { display: "full" });
  const order = data.order || {};
  return Number(order.total_paid_real || 0);
}

export async function run() {
  if (!PAID_AND_LOGABLE_STATE_ID) {
    console.error("Set PAID_AND_LOGABLE_STATE_ID to the id_order_state to scan.");
    return;
  }
  if (!(await isPaidAndLogableState(PAID_AND_LOGABLE_STATE_ID))) {
    console.warn(`State ${PAID_AND_LOGABLE_STATE_ID} is not both paid and logable, scanning anyway.`);
  }

  let flagged = 0;
  for (const order of await ordersInState(PAID_AND_LOGABLE_STATE_ID)) {
    const idOrder = order.id;
    const reference = order.reference;
    const payments = await orderPaymentsFor(reference);
    const clusters = findDuplicatePayments(payments);
    if (!clusters.length) continue;
    const paidReal = await totalPaidReal(idOrder);
    for (const cluster of clusters) {
      const row = buildReportRow(idOrder, reference, cluster, paidReal);
      flagged++;
      console.warn(
        `Duplicate order_payment found. id_order=${row.id_order} reference=${row.order_reference} ` +
          `payment_ids=${JSON.stringify(row.duplicate_payment_ids)} amount=${row.amount.toFixed(2)} ` +
          `summed=${row.summed_order_payments.toFixed(2)} total_paid_real=${row.total_paid_real.toFixed(2)} ` +
          `inflated=${row.inflated}`
      );
    }
  }
  console.log(
    `Done. ${flagged} duplicate payment cluster(s) flagged for manual review. DRY_RUN=${DRY_RUN} ` +
      `(no writes are ever performed, order_payment has no DELETE route).`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
