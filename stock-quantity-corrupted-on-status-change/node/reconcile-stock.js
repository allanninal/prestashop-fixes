/**
 * Flag and, once confirmed, repair PrestaShop stock corrupted by a duplicate
 * or reverted order status change.
 *
 * OrderHistory::changeIdOrderState() applies a signed stock delta for every state
 * transition it sees, with no memory of transitions it already applied. A duplicate
 * order_histories row for the same target state, or a reverted status, makes it
 * apply the same delta again. This script independently replays an order's status
 * timeline with a pure decision function, diffs the expected quantity against the
 * live stock_availables value, and reports a record per mismatch. It only writes a
 * compensating correction when DRY_RUN is false, and it re-reads stock right before
 * writing so the correction is based on the latest quantity.
 *
 * Guide: https://www.allanninal.dev/prestashop/stock-quantity-corrupted-on-status-change/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = (process.env.PRESTASHOP_URL || "https://example-store.test").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "DUMMYKEY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const NEUTRAL_STATE = { id: 0, logable: false, shipped: false };

export function expectedStockDelta(fromState, toState, lineQuantity, appliedStateIdsSeen, candidateStateId) {
  if (appliedStateIdsSeen.includes(candidateStateId)) return 0;
  if (!fromState.logable && toState.logable) return lineQuantity === 0 ? 0 : -lineQuantity;
  if (fromState.logable && !toState.logable) return lineQuantity;
  return 0;
}

function authHeader() {
  const token = Buffer.from(`${WS_KEY}:`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

async function apiGet(path, params = {}) {
  const qs = new URLSearchParams({ ...params, output_format: "JSON" });
  const res = await fetch(`${BASE_URL}/api/${path}?${qs}`, { headers: authHeader() });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(`${BASE_URL}/api/${path}?output_format=JSON`, {
    method: "PUT",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function orderHistory(idOrder) {
  const data = await apiGet("order_histories", { "filter[id_order]": idOrder, display: "full" });
  const rows = data.order_histories || [];
  return rows.sort((a, b) => (a.date_add || "").localeCompare(b.date_add || "") || Number(a.id) - Number(b.id));
}

async function orderLines(idOrder) {
  const data = await apiGet("order_details", { "filter[id_order]": idOrder, display: "full" });
  return data.order_details || [];
}

async function stateFlags(idOrderState) {
  const data = await apiGet(`order_states/${idOrderState}`);
  const s = data.order_state;
  return { id: Number(idOrderState), logable: s.logable === "1", shipped: s.shipped === "1" };
}

async function stockAvailable(idProduct, idProductAttribute) {
  const data = await apiGet("stock_availables", {
    "filter[id_product]": idProduct,
    "filter[id_product_attribute]": idProductAttribute || 0,
    display: "full",
  });
  const rows = data.stock_availables || [];
  return rows[0] || null;
}

export async function replayExpectedDelta(historyRows, lineQuantity, stateFlagsFn = stateFlags) {
  const seen = [];
  let total = 0;
  let fromState = { ...NEUTRAL_STATE };
  for (const row of historyRows) {
    const toId = Number(row.id_order_state);
    const toState = await stateFlagsFn(toId);
    total += expectedStockDelta(fromState, toState, lineQuantity, seen, toId);
    seen.push(toId);
    fromState = toState;
  }
  return total;
}

export function duplicateHistoryIds(historyRows) {
  const seenStateAt = new Map();
  const duplicates = [];
  for (const row of historyRows) {
    const stateId = Number(row.id_order_state);
    const rowId = Number(row.id);
    if (seenStateAt.has(stateId)) {
      duplicates.push(rowId);
    } else {
      seenStateAt.set(stateId, rowId);
    }
  }
  return duplicates;
}

async function reconcileOrder(idOrder) {
  const historyRows = await orderHistory(idOrder);
  const findings = [];
  for (const line of await orderLines(idOrder)) {
    const idProduct = Number(line.id_product);
    const idProductAttribute = Number(line.id_product_attribute || 0);
    const lineQuantity = Number(line.product_quantity);

    const expectedDelta = await replayExpectedDelta(historyRows, lineQuantity);
    const stock = await stockAvailable(idProduct, idProductAttribute);
    if (!stock) continue;
    const observedQuantity = Number(stock.quantity);

    const duplicateIds = duplicateHistoryIds(historyRows);
    if (expectedDelta === 0 && duplicateIds.length === 0) continue;

    findings.push({
      idOrder,
      idProduct,
      idProductAttribute,
      idStockAvailable: Number(stock.id),
      observedQuantity,
      expectedDelta,
      duplicateOrderHistoriesIds: duplicateIds,
    });
  }
  return findings;
}

async function applyCorrection(finding) {
  const fresh = await stockAvailable(finding.idProduct, finding.idProductAttribute);
  if (!fresh) throw new Error("stock_availables row disappeared before write");
  const before = Number(fresh.quantity);
  const after = before - finding.expectedDelta;
  fresh.quantity = String(after);
  await apiPut(`stock_availables/${finding.idStockAvailable}`, { stock_available: fresh });
  console.log(`Corrected stock_availables ${finding.idStockAvailable}: ${before} -> ${after}`);
}

export async function run(orderIds) {
  const allFindings = [];
  for (const idOrder of orderIds) {
    const findings = await reconcileOrder(idOrder);
    for (const finding of findings) {
      console.warn(
        `Order ${finding.idOrder} product ${finding.idProduct} (attr ${finding.idProductAttribute}): ` +
        `observed=${finding.observedQuantity} expected_delta=${finding.expectedDelta} ` +
        `duplicates=${JSON.stringify(finding.duplicateOrderHistoriesIds)}`
      );
    }
    allFindings.push(...findings);
  }

  if (!DRY_RUN) {
    for (const finding of allFindings) {
      await applyCorrection(finding);
    }
  }

  console.log(`Done. ${allFindings.length} finding(s) ${DRY_RUN ? "to review" : "corrected"}.`);
  return allFindings;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ids = (process.env.ORDER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  run(ids).catch((err) => { console.error(err); process.exit(1); });
}
