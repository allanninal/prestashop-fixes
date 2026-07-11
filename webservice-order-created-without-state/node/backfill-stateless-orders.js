/**
 * Find and backfill PrestaShop orders created via webservice with no state at all.
 *
 * OrderHistory::changeIdOrderState() is the only code path that both writes an
 * order_history row and updates the denormalized orders.current_state column, while
 * also firing the emails, stock, and invoice logic tied to that state. The webservice
 * orders resource exposes current_state as a plain writable field on the order object,
 * so a POST to /api/orders that omits it, or sets it directly, never runs the state
 * machine at all. The order is created with current_state at 0 (or an unapplied value)
 * and zero rows in order_history. This is documented on the PrestaShop forums under
 * "Create order via webservice won't set current state," and the reverse case, an
 * update adding an unexpected history row, is tracked as GitHub issue #11154.
 *
 * This script only ever repairs through order_histories, the same call the back
 * office makes internally. It never writes current_state directly onto an order,
 * since that is the exact bug being fixed. Run on a schedule. Safe to run again
 * and again, because a repaired order will show up with a real history row on the
 * next pass and no longer match the stateless filter.
 *
 * Guide: https://www.allanninal.dev/prestashop/webservice-order-created-without-state/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PAID_HINTS = ["payment accepted", "paiement accepté", "paid"];
const AWAITING_HINTS = ["awaiting", "en attente"];

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

function usable(s) {
  const logable = String(s.logable ?? "0");
  const hidden = String(s.hidden ?? "0");
  return ["1", "true", "True"].includes(logable) && !["1", "true", "True"].includes(hidden);
}

/**
 * Pure decision function, no I/O.
 *
 * order: object with id_order, current_state, total_paid, total_paid_real, payment, valid.
 * orderStates: array of objects, each with id, name, logable, hidden.
 * Returns the id_order_state to backfill, or null when no safe decision can be made.
 *
 * Rules:
 *   - If order.current_state is already set (not 0 and not null/undefined), return null;
 *     the caller is expected to have already confirmed no order_histories rows exist
 *     before calling this function, since current_state alone does not prove an order is
 *     stateless.
 *   - Only "usable" states are considered: logable and not hidden.
 *   - If the order is fully or over paid (totalPaidReal >= totalPaid > 0), resolve to the
 *     single usable state whose name matches a "paid" hint. If zero or more than one state
 *     matches, return null to force a manual flag rather than guess.
 *   - Otherwise resolve to the lowest-id usable state whose name matches an "awaiting
 *     payment" hint. If none match, return null.
 */
export function resolveBackfillState(order, orderStates) {
  if (order.current_state !== 0 && order.current_state != null) return null;

  const candidates = orderStates.filter(usable);
  if (candidates.length === 0) return null;

  const totalPaid = Number(order.total_paid || 0);
  const totalPaidReal = Number(order.total_paid_real || 0);

  if (totalPaid > 0 && totalPaidReal >= totalPaid) {
    const paidStates = candidates.filter((s) =>
      PAID_HINTS.some((h) => String(s.name || "").toLowerCase().includes(h))
    );
    if (paidStates.length === 1) return Number(paidStates[0].id);
    return null;
  }

  const awaitingStates = candidates.filter((s) =>
    AWAITING_HINTS.some((h) => String(s.name || "").toLowerCase().includes(h))
  );
  if (awaitingStates.length === 0) return null;
  return Number(awaitingStates.reduce((a, b) => (Number(b.id) < Number(a.id) ? b : a)).id);
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function candidateOrders() {
  const data = await apiGet("orders", { display: "full", "filter[current_state]": "0", limit: "200" });
  return data.orders || [];
}

async function isStateless(idOrder) {
  const data = await apiGet("order_histories", {
    display: "full",
    "filter[id_order]": idOrder,
    limit: "1",
  });
  const rows = data.order_histories || [];
  return rows.length === 0;
}

async function orderStates() {
  const data = await apiGet("order_states", { display: "full" });
  return data.order_states || [];
}

async function backfillViaHistory(idOrder, resolvedStateId) {
  const url = new URL(`${PRESTASHOP_URL}/api/order_histories`);
  url.searchParams.set("output_format", "JSON");
  const body = { order_history: { id_order: idOrder, id_order_state: resolvedStateId } };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on POST order_histories`);
  return res.json();
}

export async function run() {
  const states = await orderStates();
  let flagged = 0;
  let repaired = 0;
  for (const order of await candidateOrders()) {
    const idOrder = order.id;
    if (!(await isStateless(idOrder))) continue;
    flagged++;
    const resolved = resolveBackfillState(order, states);
    if (resolved === null) {
      console.warn(`Order id_order=${idOrder} is stateless but could not be safely resolved. Flagging for review.`);
      continue;
    }
    console.log(`Order id_order=${idOrder} stateless. ${DRY_RUN ? "would backfill to" : "backfilling to"} id_order_state=${resolved}`);
    if (!DRY_RUN) {
      await backfillViaHistory(idOrder, resolved);
      repaired++;
    }
  }
  console.log(`Done. ${flagged} stateless order(s) found, ${repaired} repaired. DRY_RUN=${DRY_RUN}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
