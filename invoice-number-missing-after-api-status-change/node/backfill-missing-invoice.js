/**
 * Detect and safely backfill PrestaShop orders missing an invoice after an API state change.
 *
 * An invoice number is not read off the order, it lives on a separate order_invoice row
 * that PrestaShop only creates inside Order::setInvoice(), which only runs when a new
 * order_histories entry is added for a state whose own order_state.invoice flag is 1,
 * and only while PS_INVOICE is enabled for the shop. A webservice POST to order_histories
 * updates current_state correctly but does not always trigger that same invoicing side
 * effect, and if the target state was never flagged as invoice-eligible, or the shop has
 * PS_INVOICE off, no order_invoice row is ever created no matter how the state changed.
 *
 * This script lists orders sitting on an invoice-eligible current state, reads each
 * order's existing order_invoices, and only ever writes for the safe, deterministic case:
 * the state is genuinely eligible, PS_INVOICE is on, the order is valid, and no invoice
 * row exists yet. Anything else is left alone or flagged for manual review.
 *
 * Guide: https://www.allanninal.dev/prestashop/invoice-number-missing-after-api-status-change/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const SHIPPED_STATE_ID = Number(process.env.SHIPPED_STATE_ID || 4);
const INVOICING_ENABLED = (process.env.PS_INVOICE_ENABLED || "true").toLowerCase() === "true";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * order: { id, reference, valid, current_state }
 * stateIsInvoiceable: boolean, order_state.invoice == 1 for order.current_state
 * invoicingEnabled: boolean, PS_INVOICE for the shop
 * existingInvoices: array, order.associations.order_invoices
 * Returns { action: "none" | "generate_invoice" | "flag_manual_review" | "skip", reason }
 */
export function decideInvoiceRepair(order, stateIsInvoiceable, invoicingEnabled, existingInvoices) {
  if (!invoicingEnabled) {
    return { action: "skip", reason: "ps_invoice_disabled" };
  }

  if (!stateIsInvoiceable) {
    return { action: "skip", reason: "current_state_not_invoice_eligible" };
  }

  if (existingInvoices && existingInvoices.length > 0) {
    return { action: "none", reason: "invoice_already_exists" };
  }

  if (!order.valid) {
    return { action: "flag_manual_review", reason: "order_not_valid_yet" };
  }

  return { action: "generate_invoice", reason: "eligible_state_missing_invoice" };
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function ordersOnState(stateId) {
  const data = await apiGet("orders", {
    "filter[current_state]": `[${stateId}]`,
    display: "full",
  });
  return data.orders || [];
}

async function orderStateIsInvoiceable(stateId) {
  const data = await apiGet(`order_states/${stateId}`, { display: "full" });
  const state = data.order_state || {};
  return String(state.invoice) === "1";
}

async function orderInvoicesFor(orderId) {
  const data = await apiGet(`orders/${orderId}`, { display: "full" });
  const order = data.order || {};
  const associations = order.associations || {};
  return associations.order_invoices || [];
}

async function generateInvoice(orderId) {
  const url = new URL(`${PRESTASHOP_URL}/api/order_invoices`);
  url.searchParams.set("output_format", "JSON");
  const body = { order_invoice: { id_order: orderId } };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on POST order_invoices`);
  return res.json();
}

export async function run() {
  let generated = 0;
  let flagged = 0;
  let skipped = 0;
  const stateIsInvoiceable = await orderStateIsInvoiceable(SHIPPED_STATE_ID);

  for (const order of await ordersOnState(SHIPPED_STATE_ID)) {
    const idOrder = order.id;
    const reference = order.reference;
    const existingInvoices = await orderInvoicesFor(idOrder);
    const decision = decideInvoiceRepair(order, stateIsInvoiceable, INVOICING_ENABLED, existingInvoices);

    if (decision.action === "none") continue;

    if (decision.action === "skip") {
      skipped++;
      console.log(`Order ${reference} (id=${idOrder}) skipped: ${decision.reason}`);
      continue;
    }

    if (decision.action === "flag_manual_review") {
      flagged++;
      console.warn(`Order ${reference} (id=${idOrder}) flagged for manual review: ${decision.reason}`);
      continue;
    }

    console.log(`Order ${reference} (id=${idOrder}) missing invoice. ${DRY_RUN ? "would generate" : "generating"}`);
    if (DRY_RUN) continue;

    await generateInvoice(idOrder);
    generated++;
  }

  console.log(`Done. ${generated} invoice(s) generated, ${flagged} flagged, ${skipped} skipped. DRY_RUN=${DRY_RUN}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
