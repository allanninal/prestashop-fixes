/**
 * Detect PrestaShop credit slips that ignored the order's own voucher discount.
 *
 * A voucher, or cart rule, reduces an order's total order-wide and is stored in
 * order_cart_rules, linked to id_order, not to any single order_detail line. When a
 * refund creates an order_slip, PrestaShop's core refund computation, and separately the
 * PDF or HTML credit slip template, can each total the refund from a line's gross
 * unit_price_tax_incl instead of the net amount the customer actually paid after the
 * voucher. The result is a credit slip whose total_products_tax_incl or amount is bigger
 * than it should be, effectively handing the voucher discount back as extra refund. This
 * is a long-standing, repeatedly reported defect (GitHub #18319, #19214, #28284, #34958)
 * rather than a one-off bug, and different refund paths have each been found to skip the
 * voucher reduction differently, so a generic patch should not be assumed present in any
 * given store's PrestaShop version.
 *
 * This script only ever reports. It never mutates an order_slip, because a credit slip
 * is an accounting and legal document, often already reflected in an exported invoice, a
 * posted accounting entry, or a refund that already left the bank. Every flagged order
 * is a lead for accounting staff to correct by hand through Orders, Credit Slips in the
 * back office.
 *
 * Guide: https://www.allanninal.dev/prestashop/credit-slip-ignores-voucher-discount/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const ORDER_ID_RANGE = process.env.ORDER_ID_RANGE || "1,50";

const TOLERANCE = 0.02;

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision logic, no I/O.
 *
 * Prorates each refunded line by its own qty_refunded / qty_ordered, sums those into a
 * gross refund, then applies the order-level discount ratio derived from the voucher
 * total before adding back any refunded shipping. Caller supplies all values already
 * fetched from the API.
 *
 * lineItems: array of { qty_refunded, qty_ordered, line_total_tax_incl }
 */
export function expectedRefundAmount(lineItems, voucherTotalTaxIncl, productsTotalBeforeDiscountTaxIncl,
                                      shippingRefundTaxIncl = 0) {
  const discountRatio = productsTotalBeforeDiscountTaxIncl
    ? voucherTotalTaxIncl / productsTotalBeforeDiscountTaxIncl
    : 0;

  let grossRefund = 0;
  for (const line of lineItems) {
    const qtyOrdered = line.qty_ordered;
    const prorated = qtyOrdered > 0 ? line.line_total_tax_incl * (line.qty_refunded / qtyOrdered) : 0;
    grossRefund += prorated;
  }

  const result = grossRefund * (1 - discountRatio) + shippingRefundTaxIncl;
  return Math.round(result * 100) / 100;
}

/**
 * Pure decision logic, no I/O. True when the recorded credit slip amount exceeds the
 * expected refund by more than the rounding tolerance.
 */
export function isSlipOverstated(actualSlipAmount, expectedAmount, tolerance = TOLERANCE) {
  return actualSlipAmount - expectedAmount > tolerance;
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function ordersInRange(idRange) {
  const data = await apiGet("orders", { "filter[id]": `[${idRange}]`, display: "full" });
  return data.orders || [];
}

async function orderDetailRows(idOrder) {
  const data = await apiGet("order_details", { "filter[id_order]": idOrder, display: "full" });
  return data.order_details || [];
}

async function orderCartRules(idOrder) {
  const data = await apiGet("order_cart_rules", { "filter[id_order]": idOrder, display: "full" });
  return data.order_cart_rules || [];
}

async function orderSlips(idOrder) {
  const data = await apiGet("order_slip", { "filter[id_order]": idOrder, display: "full" });
  return data.order_slip || [];
}

function slipAmount(slip) {
  const products = Number(slip.total_products_tax_incl || 0);
  const shipping = Number(slip.total_shipping_tax_incl || 0);
  return slip.amount != null ? Number(slip.amount) : products + shipping;
}

export async function run() {
  let flagged = 0;
  for (const order of await ordersInRange(ORDER_ID_RANGE)) {
    const idOrder = order.id;
    const rules = await orderCartRules(idOrder);
    if (!rules.length) continue; // no voucher on this order, nothing to check

    const voucherTotal = rules.reduce((sum, r) => sum + Number(r.value_tax_incl ?? r.value ?? 0), 0);
    const rows = await orderDetailRows(idOrder);

    const productsTotalBeforeDiscount = rows.reduce((sum, row) => sum + Number(row.total_price_tax_incl || 0), 0);
    const lineItems = rows.map((row) => ({
      qty_ordered: Number(row.product_quantity || 0),
      qty_refunded: Number(row.product_quantity_refunded || 0),
      line_total_tax_incl: Number(row.total_price_tax_incl || 0),
    }));

    const expected = expectedRefundAmount(lineItems, voucherTotal, productsTotalBeforeDiscount);

    for (const slip of await orderSlips(idOrder)) {
      const actual = slipAmount(slip);
      if (!isSlipOverstated(actual, expected)) continue;
      flagged++;
      console.warn(
        `Credit slip overstated. id_order=${idOrder} id_order_slip=${slip.id} ` +
          `voucher_value_detected=${voucherTotal.toFixed(2)} expected_refund=${expected.toFixed(2)} ` +
          `actual_slip_amount=${actual.toFixed(2)} overstated_by=${(actual - expected).toFixed(2)}`
      );
    }
  }
  console.log(`Done. ${flagged} order slip(s) flagged for review. DRY_RUN=${DRY_RUN} (report only, no writes).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
