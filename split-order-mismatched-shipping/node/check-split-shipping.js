/**
 * Detect PrestaShop split orders with a mismatched carrier or shipping cost.
 *
 * When a cart contains products assigned to different carriers, or products a carrier
 * excludes by weight or zone rules, PrestaShop's checkout splits the cart into multiple
 * orders that share the same reference but each get their own row in order_carriers, one
 * per id_order/id_order_invoice pair. The split logic frequently mis-assigns which order
 * gets which carrier row: one split order ends up with no id_carrier and 0.00 shipping
 * cost while another gets an extra, duplicated shipping charge, so total_paid summed
 * across the split orders no longer equals the original cart total, and the carrier shown
 * on an order does not match what it was actually charged.
 *
 * This script flags affected orders by default. It never overwrites id_carrier or the
 * shipping totals unless DRY_RUN is explicitly false, and even then it only attempts a
 * corrective write for the narrow shipping_cost_mismatch case, where order_carriers
 * already holds a single unambiguous row for that order. A missing carrier row entirely,
 * or a duplicated charge with no matching order_carriers row, is always left for a human.
 *
 * Guide: https://www.allanninal.dev/prestashop/split-order-mismatched-shipping/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const REFERENCES = (process.env.REFERENCES || "").split(",").map((r) => r.trim()).filter(Boolean);

const TOLERANCE = 0.01;

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision logic, no I/O.
 *
 * Groups orderCarriers by id_order, then for each order checks whether its id_carrier
 * and total_shipping_tax_incl agree with its matching order_carriers row. Returns a list
 * of {id, reference, reason} objects, reason one of missing_carrier_with_nonzero_shipping,
 * carrier_id_mismatch, shipping_cost_mismatch, zero_shipping_with_carrier_assigned.
 */
export function findShippingMismatches(orders, orderCarriers) {
  const byOrder = new Map();
  for (const row of orderCarriers) {
    const list = byOrder.get(row.id_order) || [];
    list.push(row);
    byOrder.set(row.id_order, list);
  }

  const mismatches = [];
  for (const order of orders) {
    const idOrder = order.id;
    const idCarrier = order.id_carrier || 0;
    const shipping = Number(order.total_shipping_tax_incl || 0);
    const rows = byOrder.get(idOrder) || [];

    if (rows.length === 0) {
      if (shipping > TOLERANCE) {
        mismatches.push({ id: idOrder, reference: order.reference, reason: "missing_carrier_with_nonzero_shipping" });
      }
      continue;
    }

    const row = rows[0];
    const rowCarrier = row.id_carrier || 0;
    const rowShipping = Number(row.shipping_cost_tax_incl || 0);

    if (idCarrier === 0 && rowShipping > TOLERANCE) {
      mismatches.push({ id: idOrder, reference: order.reference, reason: "zero_shipping_with_carrier_assigned" });
    } else if (idCarrier !== 0 && rowCarrier !== 0 && idCarrier !== rowCarrier) {
      mismatches.push({ id: idOrder, reference: order.reference, reason: "carrier_id_mismatch" });
    } else if (Math.abs(shipping - rowShipping) > TOLERANCE) {
      mismatches.push({ id: idOrder, reference: order.reference, reason: "shipping_cost_mismatch" });
    }
  }
  return mismatches;
}

/**
 * Pure function, no I/O.
 *
 * Returns [sumTotalPaid, expectedTotal] for a group of orders sharing one reference,
 * purely from the passed-in objects.
 */
export function reconcileReferenceTotal(ordersForReference) {
  const sumTotalPaid = Math.round(
    ordersForReference.reduce((acc, o) => acc + Number(o.total_paid_tax_incl || 0), 0) * 100
  ) / 100;
  const expectedTotal = Math.round(
    ordersForReference.reduce(
      (acc, o) =>
        acc +
        Number(o.total_products_wt || 0) +
        Number(o.total_shipping_tax_incl || 0) -
        Number(o.total_discounts_tax_incl || 0),
      0
    ) * 100
  ) / 100;
  return [sumTotalPaid, expectedTotal];
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function ordersForReference(reference) {
  const data = await apiGet("orders", { "filter[reference]": reference, display: "full" });
  return data.orders || [];
}

async function orderCarriersFor(orderIds) {
  if (orderIds.length === 0) return [];
  const idFilter = `[${orderIds.join("|")}]`;
  const data = await apiGet("order_carriers", { "filter[id_order]": idFilter, display: "full" });
  return data.order_carriers || [];
}

async function applyCarrierRowToOrder(order, row) {
  order.id_carrier = row.id_carrier;
  order.total_shipping_tax_incl = Number(row.shipping_cost_tax_incl).toFixed(6);
  order.total_shipping_tax_excl = row.shipping_cost_tax_excl || order.total_shipping_tax_excl;
  const url = new URL(`${PRESTASHOP_URL}/api/orders/${order.id}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ order }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT orders/${order.id}`);
  return res.json();
}

async function reapplyCurrentState(idOrder, idOrderState) {
  const url = new URL(`${PRESTASHOP_URL}/api/order_histories`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ order_history: { id_order: idOrder, id_order_state: idOrderState } }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on POST order_histories`);
  return res.json();
}

export async function run() {
  let flagged = 0;
  let repaired = 0;
  for (const reference of REFERENCES) {
    const orders = await ordersForReference(reference);
    if (orders.length === 0) continue;
    const orderIds = orders.map((o) => o.id);
    const rows = await orderCarriersFor(orderIds);
    const byOrder = new Map();
    for (const row of rows) {
      const list = byOrder.get(row.id_order) || [];
      list.push(row);
      byOrder.set(row.id_order, list);
    }

    const mismatches = findShippingMismatches(orders, rows);
    for (const m of mismatches) {
      flagged++;
      console.warn(`Split shipping mismatch. id=${m.id} reference=${m.reference} reason=${m.reason}`);
      if (!DRY_RUN && m.reason === "shipping_cost_mismatch") {
        const order = orders.find((o) => o.id === m.id);
        const matchingRows = byOrder.get(m.id) || [];
        if (matchingRows.length === 1) {
          await applyCarrierRowToOrder(order, matchingRows[0]);
          await reapplyCurrentState(order.id, order.current_state);
          repaired++;
          console.log(`Repaired shipping on id_order=${order.id} from order_carriers.`);
        } else {
          console.warn(`Skipping repair for id_order=${m.id}: order_carriers not unambiguous.`);
        }
      }
    }

    const [sumPaid, expected] = reconcileReferenceTotal(orders);
    if (Math.abs(sumPaid - expected) > TOLERANCE) {
      console.warn(
        `Reference total mismatch. reference=${reference} sum_total_paid=${sumPaid.toFixed(2)} expected_total=${expected.toFixed(2)}`
      );
    }
  }
  console.log(`Done. ${flagged} mismatch(es) flagged, ${repaired} repaired. DRY_RUN=${DRY_RUN}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
