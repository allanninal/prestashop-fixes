/**
 * Find and repair PrestaShop reserved_quantity drift from real pending orders.
 *
 * stock_available.reserved_quantity is a running counter PrestaShop updates as a side
 * effect of order_histories inserts, not a live query. When an order state changes
 * outside the normal flow, the decrement can be skipped and the counter never comes
 * back down. This recomputes the expected reserved quantity from real open orders,
 * diffs it against the API, and repairs drift by reposting the order's own current
 * state to order_histories, which re-triggers PrestaShop's native stock recalculation.
 * Never writes reserved_quantity or physical_quantity directly. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/prestashop/reserved-quantity-drift/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = (process.env.PRESTASHOP_URL || "https://example.test").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "dummy_key";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

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

async function logableStateIds() {
  const data = await apiGet("order_states", { display: "full" });
  const states = data.order_states || [];
  return new Set(states.filter((s) => String(s.logable) === "1" || s.logable === true).map((s) => Number(s.id)));
}

async function openOrders(logableIds) {
  const data = await apiGet("orders", { display: "full", limit: "0,1000" });
  const orders = data.orders || [];
  return orders.filter((o) => logableIds.has(Number(o.current_state)));
}

async function orderLines(idOrder) {
  const data = await apiGet("order_details", { display: "full", "filter[id_order]": idOrder });
  return data.order_details || [];
}

async function stockRows() {
  const data = await apiGet("stock_availables", { display: "full", limit: "0,1000" });
  const rows = data.stock_availables || [];
  return rows.map((r) => ({
    id_product: Number(r.id_product),
    id_product_attribute: Number(r.id_product_attribute || 0),
    reserved_quantity: Number(r.reserved_quantity || 0),
  }));
}

/** Pure function. No I/O. See reserved-quantity-drift.test.js for fixtures. */
export function computeReservedDrift(openOrderLines, logableStateIds, stockRowsList) {
  const expected = new Map();
  for (const line of openOrderLines) {
    if (!logableStateIds.has(line.id_order_state)) continue;
    const key = `${line.id_product}:${line.id_product_attribute}`;
    let remaining = line.product_quantity - line.product_quantity_refunded;
    if (remaining < 0) remaining = 0;
    expected.set(key, (expected.get(key) || 0) + remaining);
  }

  const actualByKey = new Map();
  for (const row of stockRowsList) {
    actualByKey.set(`${row.id_product}:${row.id_product_attribute}`, row.reserved_quantity);
  }

  const keys = new Set([...expected.keys(), ...actualByKey.keys()]);
  const results = [];
  for (const key of keys) {
    const [idProduct, idProductAttribute] = key.split(":").map(Number);
    const expectedReserved = expected.get(key) || 0;
    const actualReserved = actualByKey.get(key) || 0;
    if (expectedReserved !== actualReserved) {
      results.push({
        id_product: idProduct,
        id_product_attribute: idProductAttribute,
        expected_reserved: expectedReserved,
        actual_reserved: actualReserved,
        drift: actualReserved - expectedReserved,
      });
    }
  }
  return results;
}

async function resyncOrderState(idOrder, idOrderState) {
  const url = new URL(`${BASE_URL}/api/order_histories`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ order_history: { id_order: idOrder, id_order_state: idOrderState } }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function ordersTouchingProduct(openOrdersList, idProduct, idProductAttribute) {
  const matches = [];
  for (const order of openOrdersList) {
    const lines = await orderLines(order.id);
    if (lines.some((l) => Number(l.product_id) === idProduct && Number(l.product_attribute_id || 0) === idProductAttribute)) {
      matches.push(order);
    }
  }
  return matches;
}

export async function run() {
  const ids = await logableStateIds();
  const orders = await openOrders(ids);
  const lines = [];
  for (const order of orders) {
    const idState = Number(order.current_state);
    for (const line of await orderLines(order.id)) {
      lines.push({
        id_product: Number(line.product_id),
        id_product_attribute: Number(line.product_attribute_id || 0),
        product_quantity: Number(line.product_quantity || 0),
        product_quantity_refunded: Number(line.product_quantity_refunded || 0),
        id_order_state: idState,
      });
    }
  }
  const rows = await stockRows();
  const drifted = computeReservedDrift(lines, ids, rows);

  for (const item of drifted) {
    console.warn(
      `Product ${item.id_product} attribute ${item.id_product_attribute} drift: expected=${item.expected_reserved} actual=${item.actual_reserved} (${DRY_RUN ? "would resync" : "resyncing"})`
    );
    if (!DRY_RUN) {
      const touching = await ordersTouchingProduct(orders, item.id_product, item.id_product_attribute);
      for (const order of touching) {
        await resyncOrderState(order.id, Number(order.current_state));
      }
    }
  }

  console.log(`Done. ${drifted.length} drifted product/attribute row(s) ${DRY_RUN ? "to resync" : "resynced"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
