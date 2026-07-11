/**
 * Flag PrestaShop orders whose order_history rows are out of chronological order.
 *
 * order_history.date_add records write time, not true business time, so
 * current_state can end up disagreeing with the row that actually happened last.
 * This script reports only. It never edits current_state or deletes/reorders
 * order_history rows. Only with DRY_RUN=false and an explicit correct state does
 * it append one new, correctly ordered order_history row per confirmed order.
 * Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/prestashop/order-history-out-of-chronological-order/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision logic, no I/O.
 *
 * historyRows: list of { id, id_order_state, date_add } as returned by
 * /api/order_histories?filter[id_order]=...
 * currentState: the order's current_state field.
 *
 * Sorts by (date_add, id) ascending, using id as the tiebreaker/true-insertion
 * order signal since date_add can collide at second granularity. Returns a
 * violation object, or null when there is no violation.
 */
export function findChronologyViolation(historyRows, currentState) {
  if (!historyRows || historyRows.length === 0) return null;
  const ordered = [...historyRows].sort((a, b) => {
    if (a.date_add < b.date_add) return -1;
    if (a.date_add > b.date_add) return 1;
    return a.id - b.id;
  });
  const latest = ordered[ordered.length - 1];
  if (latest.id_order_state !== currentState) {
    return {
      reason: "current_state_mismatch",
      latest_history_state: latest.id_order_state,
      current_state: currentState,
      latest_id: latest.id,
    };
  }
  for (let i = 0; i < ordered.length - 1; i++) {
    const prev = ordered[i];
    const next = ordered[i + 1];
    if (prev.date_add === next.date_add && prev.id_order_state !== next.id_order_state) {
      return { reason: "duplicate_timestamp_ambiguous_order", rows: [prev, next] };
    }
  }
  return null;
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

async function orderCurrentState(idOrder) {
  const data = await apiGet(`orders/${idOrder}`, { output_format: "JSON" });
  return Number(data.order.current_state);
}

async function orderHistoryRows(idOrder) {
  const data = await apiGet("order_histories", {
    "filter[id_order]": idOrder,
    display: "full",
    sort: "id_desc",
  });
  let rows = data.order_histories || [];
  if (!Array.isArray(rows)) rows = [rows];
  return rows.map((r) => ({
    id: Number(r.id),
    id_order_state: Number(r.id_order_state),
    date_add: r.date_add,
  }));
}

async function orderIdsToCheck() {
  const data = await apiGet("orders", { display: "full", limit: "0,200" });
  let orders = data.orders || [];
  if (!Array.isArray(orders)) orders = [orders];
  return orders.map((o) => Number(o.id));
}

async function appendCorrectHistory(idOrder, idOrderState, idEmployee) {
  const body = {
    order_history: {
      id_order: idOrder,
      id_order_state: idOrderState,
      id_employee: idEmployee,
    },
  };
  return apiPost("order_histories", body);
}

export async function run() {
  let flagged = 0;
  const orderIds = await orderIdsToCheck();
  for (const idOrder of orderIds) {
    const currentState = await orderCurrentState(idOrder);
    const rows = await orderHistoryRows(idOrder);
    const violation = findChronologyViolation(rows, currentState);
    if (violation === null) continue;
    flagged++;
    console.warn(`Order ${idOrder} chronology violation:`, violation);
    if (DRY_RUN) {
      console.log(
        `DRY RUN: would POST order_histories`,
        { order_history: { id_order: idOrder, id_order_state: "<confirm manually>", id_employee: "<id>" } }
      );
    } else {
      console.log(
        "Skipping write: correct state must be confirmed by a human before calling " +
        "appendCorrectHistory(idOrder, correctState, idEmployee) explicitly."
      );
    }
  }
  console.log(`Done. ${flagged} order(s) flagged for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
