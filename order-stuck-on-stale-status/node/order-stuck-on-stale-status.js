/**
 * Detect and safely repair PrestaShop orders stuck permanently on one status.
 *
 * PrestaShop keeps order status in two places: the denormalized current_state
 * column on the order, and the append-only order_history table that core keeps
 * in step through Order::setCurrentState(). A webservice PUT to the orders
 * resource can set current_state in the payload without reliably calling that
 * method, so order_history never gets a new row and the order looks frozen.
 *
 * This polls in-progress orders, builds the terminal state set from order_states
 * instead of hardcoding it, and flags an order as stuck only when its cached
 * current_state agrees with the newest order_histories row and both are older
 * than the stale threshold. Flag-and-report is the default. Repair only ever
 * posts a corrective order_histories row, and only for a specific approved
 * order id, never a direct write to current_state. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/prestashop/order-stuck-on-stale-status/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = (process.env.PRESTASHOP_URL || "https://example.test").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "dummy_key";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const STALE_DAYS_THRESHOLD = Number(process.env.STALE_DAYS_THRESHOLD || 5);
const BOT_EMPLOYEE_ID = Number(process.env.PRESTASHOP_BOT_EMPLOYEE_ID || 0);
const IN_PROGRESS_STATE_IDS = (process.env.IN_PROGRESS_STATE_IDS || "1,2,3")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean)
  .map(Number);
// Set to an order id and its confirmed state id to approve a single repair.
const APPROVED_ORDER_ID = process.env.APPROVED_ORDER_ID;
const APPROVED_ORDER_STATE_ID = process.env.APPROVED_ORDER_STATE_ID;

const TERMINAL_STATE_NAMES = new Set(["delivered", "canceled", "cancelled", "refunded", "payment error"]);

function authHeader() {
  return "Basic " + Buffer.from(`${WS_KEY}:`).toString("base64");
}

async function apiGet(path, params) {
  const url = new URL(`${BASE_URL}/api/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function terminalStateIds() {
  const data = await apiGet("order_states", { display: "full" });
  const states = data.order_states || [];
  const ids = new Set();
  for (const s of states) {
    const name = String(s.name || "").trim().toLowerCase();
    if (TERMINAL_STATE_NAMES.has(name) || String(s.shipped) === "1" || s.shipped === true) {
      ids.add(Number(s.id));
    }
  }
  return ids;
}

async function ordersInState(idOrderState) {
  const data = await apiGet("orders", { display: "full", "filter[current_state]": idOrderState });
  return data.orders || [];
}

async function latestHistoryRow(idOrder) {
  const data = await apiGet("order_histories", {
    display: "full",
    "filter[id_order]": idOrder,
    sort: "date_add_DESC",
  });
  const rows = data.order_histories || [];
  return rows[0] || null;
}

/**
 * Pure decision logic (no I/O).
 *
 * - currentStateId: orders.current_state from GET /api/orders/{id}
 * - lastHistoryStateId: id_order_state of the most recent row from
 *   GET /api/order_histories?filter[id_order]={id}&sort=date_add_DESC (first row)
 * - lastUpdateIso: orders.date_upd (or the date_add of that latest history row)
 * - nowIso: current timestamp used by the poller
 * - terminalStateIds: Set of id_order_state values considered final
 * - staleDaysThreshold: implausible number of days with no advancement
 *
 * Returns true (flag as stuck) only when the state is not terminal, it has
 * been idle longer than the threshold, and the history genuinely agrees with
 * the cached current_state (distinguishing a true stall from a desync where
 * order_histories moved on but current_state failed to sync).
 */
export function isOrderStuck(currentStateId, lastHistoryStateId, lastUpdateIso,
                              nowIso, terminalStateIds, staleDaysThreshold = 5) {
  if (terminalStateIds.has(currentStateId)) return false;
  const lastMs = Date.parse(lastUpdateIso);
  const nowMs = Date.parse(nowIso);
  const daysIdle = Math.floor((nowMs - lastMs) / 86400000);
  if (daysIdle <= staleDaysThreshold) return false;
  return lastHistoryStateId === currentStateId;
}

async function postCorrectiveHistory(idOrder, idOrderState, idEmployee) {
  const url = new URL(`${BASE_URL}/api/order_histories`);
  url.searchParams.set("output_format", "JSON");
  url.searchParams.set("sendemail", "0");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      order_history: { id_order: idOrder, id_order_state: idOrderState, id_employee: idEmployee },
    }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function findStuckOrders() {
  const terminalIds = await terminalStateIds();
  const nowIso = new Date().toISOString();
  const stuck = [];
  for (const idState of IN_PROGRESS_STATE_IDS) {
    for (const order of await ordersInState(idState)) {
      const idOrder = Number(order.id);
      const currentStateId = Number(order.current_state ?? idState);
      const lastUpdateIso = order.date_upd || order.date_add;
      if (!lastUpdateIso) continue;
      const historyRow = await latestHistoryRow(idOrder);
      const lastHistoryStateId = historyRow ? Number(historyRow.id_order_state) : currentStateId;
      if (isOrderStuck(currentStateId, lastHistoryStateId, lastUpdateIso, nowIso, terminalIds, STALE_DAYS_THRESHOLD)) {
        stuck.push({
          id_order: idOrder,
          current_state: currentStateId,
          last_history_state: lastHistoryStateId,
          last_update: lastUpdateIso,
        });
      }
    }
  }
  return stuck;
}

export async function run() {
  const stuck = await findStuckOrders();
  for (const item of stuck) {
    console.warn(
      `Order ${item.id_order} stuck on state ${item.current_state} since ${item.last_update} (history agrees: ${item.last_history_state === item.current_state})`
    );
  }

  if (!DRY_RUN && APPROVED_ORDER_ID && APPROVED_ORDER_STATE_ID) {
    const idOrder = Number(APPROVED_ORDER_ID);
    const idState = Number(APPROVED_ORDER_STATE_ID);
    console.log(`Repairing order ${idOrder} with confirmed state ${idState}`);
    await postCorrectiveHistory(idOrder, idState, BOT_EMPLOYEE_ID);
  }

  console.log(`Done. ${stuck.length} order(s) flagged as stuck.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
