/**
 * Detect PrestaShop orders whose order_history does not match their current_state.
 *
 * PrestaShop keeps two representations of an order's status in sync by convention, not
 * by a database constraint: the denormalized orders.current_state column, and the
 * append-only order_history (ps_order_history) audit trail that is supposed to gain a
 * new row every time the state changes. When OrderHistory::changeIdOrderState() or
 * addWithemail() is interrupted, a crash during order creation, a module or webservice
 * call that writes current_state directly, or a broken insert like the id_employee
 * mismatch seen after the 8.1.0 upgrade (GitHub #33238), the order ends up pointing at a
 * state that has no matching history record. Related reports (#21502, #27967) show this
 * happening intermittently on payment-confirmation transitions and after upgrades.
 *
 * This script flags affected orders by default. It never edits orders.current_state
 * directly, since that column must only change as a side effect of an order_histories
 * insert. A confirmed repair posts a synthetic order_history row tagged id_employee=0,
 * mirroring what OrderHistory::addWithemail() would have inserted, only when DRY_RUN is
 * false and the operator has explicitly confirmed it.
 *
 * Guide: https://www.allanninal.dev/prestashop/order-history-missing-for-current-state/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const CONFIRM_REPAIR = (process.env.CONFIRM_REPAIR || "false").toLowerCase() === "true";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * currentState: number, the order's orders.current_state value.
 * historyStates: array of [idOrderState, dateAdd] tuples, in any order; this function
 *   sorts by dateAdd descending internally, so the caller does not have to pre-sort.
 *
 * Returns an object describing the problem, or null when the order's history already
 * matches currentState:
 *   - { reason: "no_history", expected_state: currentState } when historyStates is empty.
 *   - { reason: "state_mismatch", expected_state, last_recorded_state, last_recorded_date }
 *     when the latest history row (by dateAdd) does not have idOrderState === currentState.
 *   - null when the order is consistent.
 */
export function needsHistoryBackfill(currentState, historyStates) {
  if (!historyStates || historyStates.length === 0) {
    return { reason: "no_history", expected_state: currentState };
  }
  const latest = historyStates.reduce((a, b) => (b[1] > a[1] ? b : a));
  if (latest[0] !== currentState) {
    return {
      reason: "state_mismatch",
      expected_state: currentState,
      last_recorded_state: latest[0],
      last_recorded_date: latest[1],
    };
  }
  return null;
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
  const data = await apiGet("orders", { display: "[id,current_state,reference]", limit: "0" });
  return data.orders || [];
}

async function orderHistoryRows(idOrder) {
  const data = await apiGet("order_histories", {
    "filter[id_order]": idOrder,
    display: "[id,id_order,id_order_state,date_add]",
    sort: "id_DESC",
  });
  return data.order_histories || [];
}

async function validOrderStateIds() {
  const data = await apiGet("order_states", {});
  const states = data.order_states || [];
  return new Set(states.map((s) => Number(s.id)));
}

async function backfillOrderHistory(idOrder, expectedState) {
  const url = new URL(`${PRESTASHOP_URL}/api/order_histories`);
  url.searchParams.set("output_format", "JSON");
  const body = { order_history: { id_order: idOrder, id_order_state: expectedState, id_employee: 0 } };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on POST order_histories`);
  return res.json();
}

export async function run() {
  const validStates = await validOrderStateIds();
  let flagged = 0;
  let repaired = 0;
  for (const order of await allOrders()) {
    const idOrder = order.id;
    const currentState = Number(order.current_state);
    const rows = await orderHistoryRows(idOrder);
    const historyStates = rows.map((row) => [Number(row.id_order_state), row.date_add]);
    const problem = needsHistoryBackfill(currentState, historyStates);
    if (problem === null) continue;
    flagged++;
    let orphanedNote = "";
    if (problem.reason === "state_mismatch" && !validStates.has(problem.last_recorded_state)) {
      orphanedNote = " (last recorded state id is orphaned, no longer a valid order_state)";
    }
    console.warn(
      `Order needs history backfill. id_order=${idOrder} reference=${order.reference} ` +
        `current_state=${currentState} reason=${problem.reason} ` +
        `last_history_state=${problem.last_recorded_state ?? ""} last_history_date=${problem.last_recorded_date ?? ""}${orphanedNote}`
    );
    if (!DRY_RUN && CONFIRM_REPAIR) {
      await backfillOrderHistory(idOrder, currentState);
      repaired++;
      console.log(`Backfilled order_history for id_order=${idOrder} to state=${currentState} (id_employee=0).`);
    }
  }
  console.log(
    `Done. ${flagged} order(s) flagged for review, ${repaired} repaired. DRY_RUN=${DRY_RUN} CONFIRM_REPAIR=${CONFIRM_REPAIR}`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
