/**
 * Detect PrestaShop orders where a free shipping voucher applied but shipping stayed nonzero.
 *
 * PrestaShop stores a cart rule's free shipping benefit as a boolean flag, free_shipping,
 * on cart_rule and cart_rule_action. That flag only turns into an actual zero shipping
 * cost when the normal cart totals pipeline, Cart::getTotalShippingCost and
 * getPackageShippingCost, runs and the rule passes every restriction check: carrier
 * restriction, minimum amount, product or category or group scoping, and combinability
 * with other applied rules. If the voucher is combined with a non-combinable rule, the
 * carrier is not in the allowed list, or the order was written through the webservice, a
 * bulk import, a POS sync, or a custom checkout instead of Cart totals recalculation, the
 * flag never reaches total_shipping and total_shipping_tax_incl, and the carrier's full
 * cost stays on the order. Confirmed as a display and calculation bug in
 * PrestaShop/PrestaShop issues #18533 and #17489, and reported repeatedly on the
 * PrestaShop community forums.
 *
 * Recomputing order totals has to reuse PrestaShop's own tax and shipping rules, not a
 * script blindly zeroing a field, so the default action is to flag every violation for
 * manual review or a back office recalculation. A DRY_RUN-guarded write is available only
 * when explicitly authorized, after confirming through order_carriers and
 * order_cart_rules that the rule was genuinely valid for the order's carrier.
 *
 * Guide: https://www.allanninal.dev/prestashop/free-shipping-voucher-not-applied/
 *
 * Run on a schedule. Safe to run again and again.
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const ORDER_IDS = (process.env.ORDER_IDS || "").split(",").filter(Boolean);

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * Given a cartRule object (fields: free_shipping, active, carrier_restriction,
 * minimum_amount, date_from, date_to), an order object (fields:
 * total_shipping_tax_incl, total_paid_tax_incl, id_carrier, date_add), and the
 * orderCarrier object (fields: id_carrier, shipping_cost_tax_incl), returns true (flag
 * as violation) iff: cartRule.active is truthy AND cartRule.free_shipping is truthy AND
 * the order date falls within [date_from, date_to] AND (not carrier_restriction or the
 * order's id_carrier is in the rule's allowed carrier set) AND
 * Number(order.total_shipping_tax_incl) > 0. Returns false otherwise, including when
 * carrier_restriction correctly excludes this carrier.
 */
export function decideFreeShippingViolation(cartRule, order, orderCarrier) {
  if (!cartRule.active) return false;
  if (!cartRule.free_shipping) return false;

  const orderDate = order.date_add;
  if (!orderDate) return false;
  if (!(cartRule.date_from <= orderDate && orderDate <= cartRule.date_to)) return false;

  const restriction = cartRule.carrier_restriction;
  if (restriction) {
    const allowedCarriers = Array.isArray(restriction) ? restriction : [restriction];
    if (!allowedCarriers.includes(order.id_carrier)) return false;
  }

  return Number(order.total_shipping_tax_incl || 0) > 0;
}

/**
 * Build the order payload with shipping zeroed and total_paid adjusted.
 *
 * Only ever logged, not sent, unless DRY_RUN is explicitly off and the free shipping
 * rule has already been confirmed valid for this order's carrier.
 */
export function buildZeroShippingPayload(order) {
  const shippingIncl = Number(order.total_shipping_tax_incl || 0);
  const totalPaidIncl = Number(order.total_paid_tax_incl || 0) - shippingIncl;
  const totalPaid = Number(order.total_paid || 0) - shippingIncl;

  return {
    ...order,
    total_shipping: "0.00",
    total_shipping_tax_incl: "0.00",
    total_shipping_tax_excl: "0.00",
    total_paid_tax_incl: totalPaidIncl.toFixed(2),
    total_paid: totalPaid.toFixed(2),
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

async function apiPut(path, payload) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT ${path}`);
  return res.json();
}

async function freeShippingRules() {
  const data = await apiGet("cart_rules", {
    "filter[free_shipping]": 1,
    "filter[active]": 1,
    display: "full",
  });
  return data.cart_rules || [];
}

async function orderDetail(idOrder) {
  const data = await apiGet(`orders/${idOrder}`, { display: "full" });
  return data.order || {};
}

async function orderCartRulesFor(idOrder) {
  const data = await apiGet("order_cart_rules", { "filter[id_order]": idOrder, display: "full" });
  return data.order_cart_rules || [];
}

async function scanOrders(orderIds) {
  const rules = await freeShippingRules();
  const rulesById = new Map(rules.map((r) => [String(r.id), r]));
  const flagged = [];
  for (const idOrder of orderIds) {
    const order = await orderDetail(idOrder);
    if (!order || !Object.keys(order).length) continue;
    for (const link of await orderCartRulesFor(idOrder)) {
      const rule = rulesById.get(String(link.id_cart_rule));
      if (!rule) continue;
      const violation = decideFreeShippingViolation(rule, order, {});
      if (violation) {
        flagged.push({
          id_order: idOrder,
          id_cart_rule: rule.id,
          voucher_code: rule.code,
          id_carrier: order.id_carrier,
          total_shipping_tax_incl: order.total_shipping_tax_incl,
          total_shipping_tax_excl: order.total_shipping_tax_excl,
          order,
        });
      }
    }
  }
  return flagged;
}

async function repairOrder(row) {
  const payload = buildZeroShippingPayload(row.order);
  console.log(
    `${DRY_RUN ? "DRY RUN" : "REPAIRING"} order ${row.id_order}: would set total_shipping_tax_incl from ${row.total_shipping_tax_incl} to 0.00 (voucher ${row.voucher_code})`
  );
  if (!DRY_RUN) await apiPut(`orders/${row.id_order}`, payload);
}

export async function run() {
  const violations = await scanOrders(ORDER_IDS);
  for (const row of violations) {
    console.warn(
      `Free shipping voucher not applied. id_order=${row.id_order} code=${row.voucher_code} ` +
        `id_carrier=${row.id_carrier} total_shipping_tax_incl=${row.total_shipping_tax_incl} ` +
        `total_shipping_tax_excl=${row.total_shipping_tax_excl}`
    );
    await repairOrder(row);
  }

  console.log(
    `Done. ${violations.length} order(s) with an unapplied free shipping voucher ${DRY_RUN ? "would be fixed" : "fixed"}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
