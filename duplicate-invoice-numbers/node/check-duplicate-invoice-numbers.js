/**
 * Detect PrestaShop invoice numbers issued to more than one order.
 *
 * Order::setInvoice() and setLastInvoiceNumber() compute the next invoice number with a
 * query equivalent to SELECT MAX(number)+1 FROM ps_order_invoice, then write that value
 * into the new invoice row as a separate step. Nothing serializes the read and the
 * write: there is no auto-increment column backing number, and no
 * SELECT ... FOR UPDATE inside a transaction. Under concurrent checkout load, two
 * order-validation requests can both read the same current MAX before either has
 * written its own row, so both persist the identical number for two different orders.
 * Tracked upstream in PrestaShop/PrestaShop issues #28757, #23025, and #12660, reported
 * against nearly every version from 1.6 through 1.7.8.x and later, and unresolved in
 * core.
 *
 * This script only reads and reports. Invoice numbers are fiscal and legal documents in
 * most jurisdictions, so renumbering an already-issued invoice automatically is unsafe.
 * Flagged pairs need a human, an accountant or admin, to decide which order keeps the
 * number and which one gets a corrective reissued invoice through the normal Back
 * Office generate invoice action. Never PUT or PATCH order_invoices to change number
 * directly.
 *
 * Guide: https://www.allanninal.dev/prestashop/duplicate-invoice-numbers/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const DATE_START = process.env.INVOICE_DATE_START || "";
const DATE_END = process.env.INVOICE_DATE_END || "";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * invoices is an array of order_invoices rows already fetched, each with at least id,
 * id_order, number, and date_add. Groups the rows by number and returns a collision
 * object for every number whose rows span more than one distinct id_order:
 *   { number, orders: [id_order, ...], invoice_ids: [id, ...], timestamps: [date_add, ...] }
 * A single order fetched twice keeps the same id_order both times, so it is never
 * counted as a collision.
 */
export function findDuplicateInvoiceNumbers(invoices) {
  const groups = new Map();
  for (const inv of invoices) {
    if (!groups.has(inv.number)) groups.set(inv.number, []);
    groups.get(inv.number).push(inv);
  }

  const collisions = [];
  for (const [number, rows] of groups) {
    const distinctOrders = new Set(rows.map((r) => r.id_order));
    if (distinctOrders.size > 1) {
      collisions.push({
        number,
        orders: rows.map((r) => r.id_order),
        invoice_ids: rows.map((r) => r.id),
        timestamps: rows.map((r) => r.date_add),
      });
    }
  }
  return collisions;
}

export function buildReportRow(collision) {
  const [orderA, orderB] = collision.orders;
  const [dateA, dateB] = collision.timestamps;
  return {
    number: collision.number,
    id_order_a: orderA,
    id_order_b: orderB,
    invoice_ids: collision.invoice_ids,
    date_add_a: dateA,
    date_add_b: dateB,
  };
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function recentInvoices(dateStart, dateEnd) {
  const data = await apiGet("order_invoices", {
    "filter[date_add]": `[${dateStart},${dateEnd}]`,
    display: "full",
  });
  return data.order_invoices || [];
}

async function ordersByIds(idOrderA, idOrderB) {
  const data = await apiGet("orders", {
    "filter[id]": `[${idOrderA}|${idOrderB}]`,
    display: "full",
  });
  return data.orders || [];
}

async function confirmOrdersDiffer(idOrderA, idOrderB) {
  const orders = {};
  for (const o of await ordersByIds(idOrderA, idOrderB)) orders[String(o.id)] = o;
  const a = orders[String(idOrderA)];
  const b = orders[String(idOrderB)];
  if (!a || !b) return false;
  return a.id_customer !== b.id_customer || a.reference !== b.reference;
}

export async function run() {
  if (!DATE_START || !DATE_END) {
    console.error("Set INVOICE_DATE_START and INVOICE_DATE_END (YYYY-MM-DD) to the window to scan.");
    return;
  }

  const invoices = await recentInvoices(DATE_START, DATE_END);
  const collisions = findDuplicateInvoiceNumbers(invoices);

  let flagged = 0;
  for (const collision of collisions) {
    const [idOrderA, idOrderB] = collision.orders;
    if (!(await confirmOrdersDiffer(idOrderA, idOrderB))) continue;
    const row = buildReportRow(collision);
    flagged++;
    console.warn(
      `Duplicate invoice number found. number=${row.number} id_order_a=${row.id_order_a} ` +
        `id_order_b=${row.id_order_b} invoice_ids=${JSON.stringify(row.invoice_ids)} ` +
        `date_add_a=${row.date_add_a} date_add_b=${row.date_add_b}`
    );
  }
  console.log(
    `Done. ${flagged} duplicate invoice number(s) flagged for manual review. DRY_RUN=${DRY_RUN} ` +
      `(no writes are ever performed, invoice numbers are never changed automatically).`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
