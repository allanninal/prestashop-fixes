/**
 * Detect PrestaShop orders whose carrier reference has gone invalid.
 *
 * PrestaShop never removes a carrier row when you delete it in the back office, it only
 * sets carrier.deleted = 1, so old orders keep pointing at an id that is now hidden from
 * every UI and most webservice lists. Editing a carrier's settings is worse: PrestaShop
 * duplicates the row under the same id_reference and hides the old one, so historic
 * orders keep referencing a dead id. Editing an order's product lines can trigger a
 * shipping recalculation that surfaces "The order carrier ID is invalid" (core issue
 * #24307), and core issue #17355 documents that the back office then blocks editing that
 * order's shipping and tracking at all. A webservice bug (#11945) can also leave
 * id_carrier at 0.
 *
 * This script flags affected orders by default. It never repoints an order's carrier
 * unless DRY_RUN is explicitly false, and even then it only writes when a currently
 * active carrier shares the dead carrier's id_reference. Every other case is left for a
 * human.
 *
 * Guide: https://www.allanninal.dev/prestashop/order-carrier-invalid-after-line-edit/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const DATE_UPD_FROM = process.env.DATE_UPD_FROM || "";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision logic, no I/O.
 *
 * Returns "zero" if orderIdCarrier is 0, null, or undefined, "deleted" if it is a known
 * soft-deleted carrier id, "missing" if it is in neither set, otherwise "ok".
 */
export function classifyOrderCarrier(orderIdCarrier, validCarrierIds, deletedCarrierIds) {
  if (orderIdCarrier === 0 || orderIdCarrier === null || orderIdCarrier === undefined) return "zero";
  if (deletedCarrierIds.has(orderIdCarrier)) return "deleted";
  if (!validCarrierIds.has(orderIdCarrier) && !deletedCarrierIds.has(orderIdCarrier)) return "missing";
  return "ok";
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function apiPut(path, body) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT ${path}`);
  return res.json();
}

async function listOrders(dateUpdFrom) {
  const params = { display: "full" };
  if (dateUpdFrom) params["filter[date_upd]"] = `>[${dateUpdFrom}]`;
  const data = await apiGet("orders", params);
  return data.orders || [];
}

async function carrierSets() {
  const data = await apiGet("carriers", { display: "full", "filter[deleted]": "[0,1]" });
  const carriers = data.carriers || [];
  const validIds = new Set(carriers.filter((c) => String(c.deleted) === "0").map((c) => Number(c.id)));
  const deletedIds = new Set(carriers.filter((c) => String(c.deleted) === "1").map((c) => Number(c.id)));
  return { validIds, deletedIds, carriers };
}

async function carrierById(idCarrier) {
  const data = await apiGet(`carriers/${idCarrier}`, {});
  return data?.carrier;
}

async function orderCarrierRows(idOrder) {
  const data = await apiGet("order_carriers", { "filter[id_order]": idOrder, display: "full" });
  return data.order_carriers || [];
}

function carrierWithReference(activeCarriers, idReference) {
  return (
    activeCarriers.find((c) => String(c.id_reference) === String(idReference) && String(c.deleted) === "0") || null
  );
}

function buildReportRow(order, reason, deadCarrier) {
  return {
    id: order.id,
    reference: order.reference,
    id_carrier: order.id_carrier,
    carrier_valid: false,
    reason,
    last_known_id_reference: deadCarrier ? deadCarrier.id_reference : null,
  };
}

async function repointOrderCarrier(order, orderCarrierRow, newIdCarrier) {
  order.id_carrier = newIdCarrier;
  await apiPut(`orders/${order.id}`, { order });
  if (orderCarrierRow) {
    orderCarrierRow.id_carrier = newIdCarrier;
    await apiPut(`order_carriers/${orderCarrierRow.id}`, { order_carrier: orderCarrierRow });
  }
  await apiPut("order_histories", { order_history: { id_order: order.id, id_order_state: order.current_state } });
}

export async function run() {
  const orders = await listOrders(DATE_UPD_FROM || undefined);
  const { validIds, deletedIds, carriers } = await carrierSets();

  let flagged = 0;
  let repaired = 0;
  for (const order of orders) {
    const rawIdCarrier = order.id_carrier;
    const idCarrier = rawIdCarrier === null || rawIdCarrier === undefined || rawIdCarrier === "" ? 0 : Number(rawIdCarrier);
    const reason = classifyOrderCarrier(idCarrier, validIds, deletedIds);
    if (reason === "ok") continue;

    flagged++;
    const deadCarrier = idCarrier ? await carrierById(idCarrier) : null;
    const row = buildReportRow(order, reason, deadCarrier);
    console.warn(
      `Invalid order carrier. id=${row.id} reference=${row.reference} id_carrier=${row.id_carrier} reason=${row.reason} last_known_id_reference=${row.last_known_id_reference}`
    );

    if (!DRY_RUN && deadCarrier && deadCarrier.id_reference) {
      const replacement = carrierWithReference(carriers, deadCarrier.id_reference);
      if (replacement) {
        const ocRows = await orderCarrierRows(order.id);
        const ocRow = ocRows[0] || null;
        await repointOrderCarrier(order, ocRow, Number(replacement.id));
        repaired++;
        console.log(`Repointed id_order=${order.id} to active carrier id=${replacement.id}.`);
      } else {
        console.warn(`Skipping repair for id_order=${order.id}: no active carrier shares id_reference=${deadCarrier.id_reference}.`);
      }
    }
  }

  console.log(`Done. ${flagged} order(s) flagged, ${repaired} repointed. DRY_RUN=${DRY_RUN}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
