/**
 * Flag and clean up duplicate PrestaShop order_history rows for a single status change.
 *
 * Order::setCurrentState() historically ran its full body, insert order_history,
 * send the email, fire the hooks, every time it was called, without checking whether
 * the order already had the requested state. A retried webhook, a duplicated IPN call,
 * or a webservice client blindly re-sending current_state can insert the same
 * order_history row twice. This script reports duplicate ids by default. Only with
 * DRY_RUN=false does it delete the flagged duplicate ids, never the first row of a
 * run and never the order's current_state field. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/prestashop/duplicate-order-history-rows/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function, no I/O.
 *
 * Input: historyRows, an array of objects with at least
 * { id: number, id_order_state: number, date_add: string }, already scoped to
 * one id_order.
 *
 * Sorts a copy of historyRows by (date_add, id) ascending, then walks the
 * list tracking the previous row's id_order_state. Whenever the current row's
 * id_order_state equals the previous row's, the current row's id is flagged
 * as a duplicate. The earlier row in each run is always kept, only the
 * repeat(s) are flagged. The tracker resets to the current row's state after
 * every comparison, so a run longer than two is fully flagged except the
 * first row. Returns the array of duplicate ids (empty array if none).
 */
export function findDuplicateHistoryIds(historyRows) {
  if (!historyRows || historyRows.length === 0) return [];
  const ordered = [...historyRows].sort((a, b) => {
    if (a.date_add < b.date_add) return -1;
    if (a.date_add > b.date_add) return 1;
    return a.id - b.id;
  });
  const duplicateIds = [];
  let previousState = null;
  for (const row of ordered) {
    if (previousState !== null && row.id_order_state === previousState) {
      duplicateIds.push(row.id);
    }
    previousState = row.id_order_state;
  }
  return duplicateIds;
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

async function apiDelete(path) {
  const res = await fetch(`${BASE_URL}/api/${path}?output_format=JSON`, {
    method: "DELETE",
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return true;
}

async function orderHistoryRows(idOrder) {
  const data = await apiGet("order_histories", {
    "filter[id_order]": idOrder,
    display: "full",
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

async function deleteDuplicateHistory(idOrderHistory) {
  return apiDelete(`order_histories/${idOrderHistory}`);
}

export async function run() {
  let flagged = 0;
  const orderIds = await orderIdsToCheck();
  for (const idOrder of orderIds) {
    const rows = await orderHistoryRows(idOrder);
    const duplicateIds = findDuplicateHistoryIds(rows);
    if (duplicateIds.length === 0) continue;
    flagged += duplicateIds.length;
    console.warn(`Order ${idOrder} has duplicate order_history ids:`, duplicateIds);
    if (DRY_RUN) {
      console.log(`DRY RUN: would delete order_histories ${duplicateIds} for order ${idOrder}`);
    } else {
      for (const idOrderHistory of duplicateIds) {
        await deleteDuplicateHistory(idOrderHistory);
      }
      const remaining = await orderHistoryRows(idOrder);
      console.log(`Order ${idOrder} cleaned up. Remaining history states:`, remaining.map((r) => r.id_order_state));
    }
  }
  console.log(`Done. ${flagged} duplicate order_history row(s) ${DRY_RUN ? "to delete" : "deleted"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
