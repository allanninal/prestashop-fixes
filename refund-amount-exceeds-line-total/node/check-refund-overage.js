/**
 * Detect PrestaShop order lines where a partial refund exceeds the line's own total.
 *
 * PrestaShop's partial-refund flow, whether through the back office Order Refund form, the
 * actionOrderSlipAdd hook, or a direct write through the webservice, computes the refunded
 * amount from whatever the operator or API caller submits. There is no consistent
 * server-side cap comparing that number against the order line's own product_quantity and
 * total_price_tax_incl, so a client that skips the back-office form can post a refund that
 * exceeds the line total with no rejection. The confirmed side effect is that
 * product_quantity_refunded can exceed product_quantity, since PrestaShop does not
 * recompute or cap product_quantity against refunds already issued.
 *
 * This script only ever reports. It never mutates an order_detail row or an order_slip,
 * because a refund is a financial transaction already reflected in a credit note and
 * possibly reconciled with a payment gateway. The only corrective code here is a
 * preventive guard meant to be called before a NEW refund is created, not a repair of
 * history.
 *
 * Guide: https://www.allanninal.dev/prestashop/refund-amount-exceeds-line-total/
 *
 * Run on a schedule. Safe to run again and again.
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const ORDER_ID_RANGE = process.env.ORDER_ID_RANGE || "1,50";

const EPSILON = 0.01;

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision logic, no I/O.
 *
 * Compares the refunded quantity and amount against the order line's own quantity and
 * total, and returns an object describing whether either one overshoots, and by how much.
 * Caller supplies all values already fetched from the API.
 *
 * Returns { overage: boolean, quantity_overage: number, amount_overage: number }.
 */
export function isRefundOverage(productQuantity, productQuantityRefunded, lineTotalTaxIncl,
                                 refundedAmountTaxIncl, epsilon = EPSILON) {
  const quantityOverage = Math.max(0, productQuantityRefunded - productQuantity);
  const rawAmountOverage = Math.round((refundedAmountTaxIncl - lineTotalTaxIncl) * 100) / 100;
  const amountOverage = rawAmountOverage > epsilon ? rawAmountOverage : 0.0;
  const overage = quantityOverage > 0 || amountOverage > epsilon;
  return {
    overage,
    quantity_overage: quantityOverage,
    amount_overage: amountOverage,
  };
}

/**
 * Preventive guard for a NEW refund request, before it is ever sent.
 *
 * Rejects when the requested quantity or amount would exceed the line's remaining
 * unrefunded balance. This never touches a refund that already happened, it only stops
 * the next one from repeating the mistake.
 */
export function wouldNewRefundOvershoot(productQuantity, productQuantityRefunded,
                                         lineTotalTaxIncl, alreadyRefundedTaxIncl,
                                         requestedQuantity, requestedAmountTaxIncl) {
  const remainingQuantity = productQuantity - productQuantityRefunded;
  const remainingAmount = Math.round((lineTotalTaxIncl - alreadyRefundedTaxIncl) * 100) / 100;
  return requestedQuantity > remainingQuantity || requestedAmountTaxIncl > remainingAmount + EPSILON;
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

function refundedAmountForRow(row) {
  const qtyRefunded = Number(row.product_quantity_refunded || 0);
  const unitPrice = Number(row.unit_price_tax_incl || 0);
  return Math.round(qtyRefunded * unitPrice * 100) / 100;
}

export async function run() {
  let flagged = 0;
  for (const order of await ordersInRange(ORDER_ID_RANGE)) {
    const idOrder = order.id;
    for (const row of await orderDetailRows(idOrder)) {
      const productQuantity = Number(row.product_quantity || 0);
      const productQuantityRefunded = Number(row.product_quantity_refunded || 0);
      const lineTotalTaxIncl = Number(row.total_price_tax_incl || 0);
      const refundedAmount = refundedAmountForRow(row);
      const result = isRefundOverage(productQuantity, productQuantityRefunded, lineTotalTaxIncl, refundedAmount);
      if (!result.overage) continue;
      flagged++;
      console.warn(
        `Refund overage. id_order=${idOrder} id_order_detail=${row.id} ` +
          `product_quantity=${productQuantity} product_quantity_refunded=${productQuantityRefunded} ` +
          `total_price_tax_incl=${lineTotalTaxIncl.toFixed(2)} refunded_amount=${refundedAmount.toFixed(2)} ` +
          `quantity_overage=${result.quantity_overage} amount_overage=${result.amount_overage.toFixed(2)}`
      );
    }
  }
  console.log(`Done. ${flagged} line(s) flagged for review. DRY_RUN=${DRY_RUN} (report only, no writes).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
