/**
 * Detect and safely repair PrestaShop orders stuck in Payment error after webservice creation.
 *
 * Order validation, PaymentModule::validateOrder() and, on some 1.7.x releases,
 * Order::createOrderFromCart() where the check moved (PrestaShop/PrestaShop#15834),
 * compares the cart's computed total against the amount_paid the caller supplied and
 * forces the order into Configuration::PS_OS_ERROR, the Payment error state, whenever
 * number_format(cart_total_paid, precision) != number_format(amount_paid, precision).
 * Webservice integrations often omit or miscalculate total_shipping or total_paid_real,
 * since the API never computes shipping or tax for you, so the number sent and the
 * number the order actually settles on drift apart.
 *
 * This script lists orders in the error state, reads each order_payments row, recomputes
 * the true cart total, and only ever writes for the safe, deterministic case: the order's
 * own total_paid already agrees with the cart, but the recorded payment amount does not.
 * If total_paid itself diverges from the cart, the order is flagged for manual review,
 * since changing total_paid affects invoicing and accounting integrity.
 *
 * Guide: https://www.allanninal.dev/prestashop/webservice-order-payment-error-mismatch/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const ERROR_STATE_ID = Number(process.env.ERROR_STATE_ID || 8);
const PAID_STATE_ID = Number(process.env.PAID_STATE_ID || 2);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * order: { id, total_paid, total_paid_real, current_state }
 * orderPayment: { amount } or null
 * computedCartTotal: number, total_products_wt + total_shipping - total_discounts
 *
 * Returns { action, reason, correctedAmount? } where action is one of:
 *   - "none": totals already agree, nothing to do.
 *   - "correct_payment_amount": the order's own total_paid already matches the
 *     recomputed cart total, but order_payments.amount disagrees with it. Safe,
 *     deterministic fix: correct the payment row to match total_paid.
 *   - "flag_manual_review": either there is no order_payments row to compare
 *     against, or total_paid itself diverges from the recomputed cart total.
 *     Never auto-corrected, since total_paid feeds invoicing and accounting.
 */
export function decideOrderPaymentRepair(order, orderPayment, computedCartTotal, precision = 2) {
  const round = (n) => Number(Number(n).toFixed(precision));
  const orderTotal = round(order.total_paid);
  const cartTotal = round(computedCartTotal);

  if (!orderPayment) {
    return { action: "flag_manual_review", reason: "no_order_payment_row_found" };
  }
  const paidAmount = round(orderPayment.amount);

  if (orderTotal !== cartTotal) {
    return { action: "flag_manual_review", reason: "order_total_paid_diverges_from_cart_total" };
  }

  if (paidAmount !== orderTotal) {
    return {
      action: "correct_payment_amount",
      reason: "order_payment_amount_mismatches_order_total_paid",
      correctedAmount: orderTotal,
    };
  }

  return { action: "none", reason: "totals_reconciled" };
}

/** Pure helper: total_products_wt + total_shipping - total_discounts, rounded to 2dp. */
export function computedCartTotal(cart) {
  const products = Number(cart.total_products_wt || 0);
  const shipping = Number(cart.total_shipping || 0);
  const discounts = Number(cart.total_discounts || 0);
  return Math.round((products + shipping - discounts) * 100) / 100;
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function ordersInError() {
  const data = await apiGet("orders", {
    "filter[current_state]": `[${ERROR_STATE_ID}]`,
    display: "full",
  });
  return data.orders || [];
}

async function orderPaymentFor(reference) {
  const data = await apiGet("order_payments", {
    "filter[order_reference]": reference,
    display: "full",
  });
  const rows = data.order_payments || [];
  return rows[0] || null;
}

async function cartTotalFor(idCart) {
  const data = await apiGet(`carts/${idCart}`, { display: "full" });
  const cart = data.cart || {};
  return computedCartTotal(cart);
}

async function correctOrderPayment(orderPayment, correctedAmount) {
  const url = new URL(`${PRESTASHOP_URL}/api/order_payments/${orderPayment.id}`);
  url.searchParams.set("output_format", "JSON");
  const body = {
    order_payment: {
      id: orderPayment.id,
      order_reference: orderPayment.order_reference,
      amount: correctedAmount,
      payment_method: orderPayment.payment_method,
      date_add: orderPayment.date_add,
    },
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT order_payments`);
  return res.json();
}

async function advanceOrderState(idOrder, idOrderState) {
  const url = new URL(`${PRESTASHOP_URL}/api/order_histories`);
  url.searchParams.set("output_format", "JSON");
  const body = { order_history: { id_order: idOrder, id_order_state: idOrderState, id_employee: 0 } };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on POST order_histories`);
  return res.json();
}

export async function run() {
  let repaired = 0;
  let flagged = 0;
  for (const order of await ordersInError()) {
    const idOrder = order.id;
    const reference = order.reference;
    const payment = await orderPaymentFor(reference);
    const cartTotal = await cartTotalFor(order.id_cart);
    const decision = decideOrderPaymentRepair(order, payment, cartTotal);

    if (decision.action === "none") continue;

    if (decision.action === "flag_manual_review") {
      flagged++;
      console.warn(`Order ${reference} (id=${idOrder}) flagged for manual review: ${decision.reason}`);
      continue;
    }

    const oldAmount = payment.amount;
    const newAmount = decision.correctedAmount;
    console.log(
      `Order ${reference} (id=${idOrder}) payment amount ${oldAmount} -> ${newAmount}. ${DRY_RUN ? "would correct" : "correcting"}`
    );
    if (DRY_RUN) continue;

    await correctOrderPayment(payment, newAmount);
    await advanceOrderState(idOrder, PAID_STATE_ID);
    repaired++;
  }
  console.log(`Done. ${repaired} order(s) repaired, ${flagged} flagged for review. DRY_RUN=${DRY_RUN}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
