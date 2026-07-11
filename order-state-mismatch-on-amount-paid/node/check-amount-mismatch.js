/**
 * Detect PrestaShop orders whose total_paid_real does not match total_paid.
 *
 * Order validation writes whatever state a payment module or the back office asks for,
 * along with the matching order_histories row, without independently re-checking that
 * total_paid_real actually equals total_paid. A module that confirms an order on a
 * partial payment, a currency rounding difference, or a manual state change in the back
 * office can all leave an order sitting on a normal, paid-looking state while the two
 * amount fields disagree underneath it.
 *
 * This script flags affected orders by default. It never edits total_paid,
 * total_paid_real, or current_state directly, since a state change should only ever
 * happen through a new order_histories row. A confirmed repair posts that new row with
 * the state a human decided the order should actually be in, only when DRY_RUN is false
 * and the operator has explicitly confirmed it.
 *
 * Guide: https://www.allanninal.dev/prestashop/order-state-mismatch-on-amount-paid/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const CONFIRM_REPAIR = (process.env.CONFIRM_REPAIR || "false").toLowerCase() === "true";
const REVIEWED_STATE = Number(process.env.REVIEWED_STATE || 0);

const TOLERANCE = 0.01;

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * Compares totalPaidReal against totalPaid with a small rounding tolerance. Returns an
 * object describing the problem, including whether currentState is one PrestaShop
 * itself flags as paid, or null when the amounts already agree.
 */
export function amountMismatch(totalPaid, totalPaidReal, currentState, paidStateIds) {
  const diff = Math.round((totalPaidReal - totalPaid) * 100) / 100;
  if (Math.abs(diff) <= TOLERANCE) return null;
  return {
    reason: "amount_mismatch",
    total_paid: totalPaid,
    total_paid_real: totalPaidReal,
    difference: diff,
    current_state_is_paid: paidStateIds.has(currentState),
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

async function allOrders() {
  const data = await apiGet("orders", {
    display: "[id,reference,current_state,total_paid,total_paid_real]",
    limit: "0",
  });
  return data.orders || [];
}

async function paidStateIds() {
  const data = await apiGet("order_states", { display: "[id,paid]" });
  const states = data.order_states || [];
  return new Set(
    states.filter((s) => ["1", "true", "True"].includes(String(s.paid))).map((s) => Number(s.id))
  );
}

async function applyReviewedState(idOrder, reviewedState) {
  const url = new URL(`${PRESTASHOP_URL}/api/order_histories`);
  url.searchParams.set("output_format", "JSON");
  const body = { order_history: { id_order: idOrder, id_order_state: reviewedState, id_employee: 0 } };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on POST order_histories`);
  return res.json();
}

export async function run() {
  const paidStates = await paidStateIds();
  let flagged = 0;
  let repaired = 0;
  for (const order of await allOrders()) {
    const idOrder = order.id;
    const currentState = Number(order.current_state);
    const totalPaid = Number(order.total_paid);
    const totalPaidReal = Number(order.total_paid_real);
    const problem = amountMismatch(totalPaid, totalPaidReal, currentState, paidStates);
    if (problem === null) continue;
    flagged++;
    const urgentNote = problem.current_state_is_paid ? " (current state claims to be paid)" : "";
    console.warn(
      `Order has an amount mismatch. id_order=${idOrder} reference=${order.reference} ` +
        `current_state=${currentState} total_paid=${totalPaid.toFixed(2)} ` +
        `total_paid_real=${totalPaidReal.toFixed(2)} difference=${problem.difference.toFixed(2)}${urgentNote}`
    );
    if (!DRY_RUN && CONFIRM_REPAIR && REVIEWED_STATE) {
      await applyReviewedState(idOrder, REVIEWED_STATE);
      repaired++;
      console.log(`Applied reviewed state=${REVIEWED_STATE} for id_order=${idOrder} (id_employee=0).`);
    }
  }
  console.log(
    `Done. ${flagged} order(s) flagged for review, ${repaired} repaired. DRY_RUN=${DRY_RUN} CONFIRM_REPAIR=${CONFIRM_REPAIR}`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
