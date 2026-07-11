/**
 * Detect and repair PrestaShop orders whose current_state has gone stale.
 *
 * PrestaShop keeps two representations of an order's status: the append-only
 * order_history table, one row per transition, and a denormalized current_state
 * column on the orders row, kept purely as a read-optimization for order lists,
 * filters, and exports. The core only synchronizes these inside
 * Order::setCurrentState() and OrderHistory::addWithemail(), which insert a new
 * history row and then write that same state into orders.current_state in the
 * same call. If a history row is deleted or edited directly, by a bad module, a
 * GDPR or cleanup script, a manual database fix, or an admin removing a
 * wrongly-added status line, that write path is bypassed, so current_state keeps
 * pointing at whatever was last set and silently diverges from what the history
 * now shows as most recent. This is the desync reported in PrestaShop GitHub
 * issue #13390.
 *
 * This script logs every stale pointer it finds. It never inserts a new
 * order_history row for a correction, since that would trigger a customer
 * notification email and further pollute an already-edited history. A confirmed
 * repair only overwrites orders.current_state, and only when DRY_RUN is false.
 * Orders with zero history rows are skipped and flagged, since there is no safe
 * state to recompute from.
 *
 * Guide: https://www.allanninal.dev/prestashop/order-current-state-stale-after-history-edit/
 *
 * Run on a schedule. Safe to run again and again.
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * historyRows is an array of objects, each with at least "id", "id_order_state",
 * and "date_add" as an ISO-ish string, in any order. Returns the id_order_state
 * of the row with the lexicographically-max date_add, breaking ties by the
 * largest id (order_history ids are auto-increment and insert-ordered). Returns
 * null when historyRows is empty, which signals "flag this order, do not
 * repair it."
 */
export function computeCorrectCurrentState(historyRows) {
  if (!historyRows || historyRows.length === 0) return null;
  const best = historyRows.reduce((a, b) => {
    const aKey = [a.date_add || "", Number(a.id)];
    const bKey = [b.date_add || "", Number(b.id)];
    if (bKey[0] !== aKey[0]) return bKey[0] > aKey[0] ? b : a;
    return bKey[1] > aKey[1] ? b : a;
  });
  return Number(best.id_order_state);
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
    display: "[id,id_order_state,date_add]",
  });
  return data.order_histories || [];
}

async function patchCurrentState(idOrder, correctState) {
  const body = await apiGet(`orders/${idOrder}`);
  body.order.current_state = String(correctState);
  const url = new URL(`${PRESTASHOP_URL}/api/orders/${idOrder}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT orders/${idOrder}`);
  return res.json();
}

export async function run() {
  let flagged = 0;
  let repaired = 0;
  for (const order of await allOrders()) {
    const idOrder = order.id;
    const staleState = Number(order.current_state);
    const rows = await orderHistoryRows(idOrder);
    const correctState = computeCorrectCurrentState(rows);
    if (correctState === null) {
      flagged++;
      console.warn(
        `Order id_order=${idOrder} reference=${order.reference} has zero order_history rows. Skipping, flagged for review.`
      );
      continue;
    }
    if (correctState === staleState) continue;
    flagged++;
    console.log(
      `Order id_order=${idOrder} reference=${order.reference} stale_current_state=${staleState} ` +
        `correct_current_state=${correctState}. ${DRY_RUN ? "would patch" : "patching"}`
    );
    if (!DRY_RUN) {
      await patchCurrentState(idOrder, correctState);
      repaired++;
    }
  }
  console.log(`Done. ${flagged} order(s) flagged, ${repaired} ${DRY_RUN ? "would be patched" : "patched"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
