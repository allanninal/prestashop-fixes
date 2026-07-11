/**
 * Detect PrestaShop orders whose total went stale after a product line was
 * cancelled while a voucher was attached.
 *
 * Cancelling a product from an order in Back Office > Orders (OrderController /
 * the Order class) recalculates the remaining order_detail line totals, but it
 * does not re-derive total_discounts from the cart rules still attached to the
 * order (order_cart_rules). A cart rule computed as a percent-of-total, a fixed
 * amount, or free shipping was calculated once against the cart as it stood at
 * checkout, so once a line is cancelled that original cart total no longer
 * exists and the stored discount goes stale, along with total_paid and
 * total_paid_tax_incl. Tracked upstream across PrestaShop/PrestaShop issues
 * #17347, #23358, #23038, #28134, with the invalid-discount shape (negative or
 * tax_excl greater than tax_incl) tracked separately as issue #11059.
 *
 * This script defaults to detect and report only, since an order's total may
 * already be referenced by an invoice or an accounting export. The corrective
 * PUT to orders only runs under an explicit DRY_RUN=false override, always
 * prints a before/after diff, and never touches current_state (order state
 * changes belong only to POST /api/order_histories).
 *
 * Guide: https://www.allanninal.dev/prestashop/order-total-wrong-after-line-cancel-with-voucher/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const ORDER_IDS = (process.env.ORDER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const TOLERANCE = 0.02;

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * orderDetails is the array of order_details rows still present on the order
 * (already fetched by the caller). orderCartRules is the array of
 * order_cart_rules rows for the order (already fetched). totalShipping and
 * reportedTotalTaxIncl are plain values already read from the order. Returns
 * the expected total, the delta against what the order reports, whether that
 * delta exceeds tolerance, and whether the cart rule values have the invalid
 * shape from issue #11059 (negative, or tax_excl sum greater than the
 * tax_incl sum).
 */
export function recomputeOrderTotal(orderDetails, orderCartRules, totalShipping,
                                     reportedTotalTaxIncl, tolerance = TOLERANCE) {
  const linesSum = orderDetails.reduce((sum, d) => sum + Number(d.total_price_tax_incl), 0);
  const activeRules = orderCartRules.filter((r) => String(r.deleted ?? "0") === "0");
  const cartRulesSum = activeRules.reduce((sum, r) => sum + Number(r.value), 0);
  const expected = linesSum + Number(totalShipping) - cartRulesSum;
  const reported = Number(reportedTotalTaxIncl);
  const delta = reported - expected;

  let invalidShape = activeRules.some((r) => Number(r.value) < 0);
  const taxExclSum = activeRules.reduce(
    (sum, r) => sum + Number(r.value_tax_excl ?? r.value),
    0
  );
  if (taxExclSum > cartRulesSum) invalidShape = true;

  return {
    expected_total: expected,
    reported_total: reported,
    delta,
    is_mismatched: Math.abs(delta) > tolerance,
    invalid_discount_shape: invalidShape,
  };
}

export function buildReportRow(idOrder, result, activeRuleIds) {
  return {
    id_order: idOrder,
    expected_total: Math.round(result.expected_total * 100) / 100,
    reported_total: Math.round(result.reported_total * 100) / 100,
    delta: Math.round(result.delta * 100) / 100,
    is_mismatched: result.is_mismatched,
    invalid_discount_shape: result.invalid_discount_shape,
    order_cart_rules_summed: activeRuleIds,
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

async function getOrder(idOrder) {
  const data = await apiGet(`orders/${idOrder}`);
  return data.order || {};
}

async function orderDetailsFor(idOrder) {
  const data = await apiGet("order_details", {
    "filter[id_order]": idOrder,
    display: "full",
  });
  return data.order_details || [];
}

async function orderCartRulesFor(idOrder) {
  const data = await apiGet("order_cart_rules", {
    "filter[id_order]": idOrder,
    display: "full",
  });
  return data.order_cart_rules || [];
}

/**
 * Only called when DRY_RUN is explicitly false. Sends the full order body
 * back with corrected discount and paid totals. Never touches current_state;
 * state changes go only through POST /api/order_histories.
 */
async function applyCorrection(idOrder, order, result, activeRules) {
  const cartRulesSum = activeRules.reduce((sum, r) => sum + Number(r.value), 0);
  const taxExclSum = activeRules.reduce((sum, r) => sum + Number(r.value_tax_excl ?? r.value), 0);
  const corrected = { ...order };
  corrected.total_discounts = String(cartRulesSum);
  corrected.total_discounts_tax_incl = String(cartRulesSum);
  corrected.total_discounts_tax_excl = String(taxExclSum);
  corrected.total_paid = String(result.expected_total);
  corrected.total_paid_tax_incl = String(result.expected_total);
  corrected.total_paid_tax_excl = String(result.expected_total - (cartRulesSum - taxExclSum));
  delete corrected.current_state;

  console.warn(`BEFORE: total_paid_tax_incl=${order.total_paid_tax_incl} total_discounts=${order.total_discounts}`);
  console.warn(`AFTER:  total_paid_tax_incl=${corrected.total_paid_tax_incl} total_discounts=${corrected.total_discounts}`);

  const url = new URL(`${PRESTASHOP_URL}/api/orders/${idOrder}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ order: corrected }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT orders/${idOrder}`);
  return res.json();
}

export async function run() {
  if (!ORDER_IDS.length) {
    console.error("Set ORDER_IDS to a comma separated list of order ids to check.");
    return;
  }

  let flagged = 0;
  for (const idOrder of ORDER_IDS) {
    const order = await getOrder(idOrder);
    if (!order || !Object.keys(order).length) {
      console.warn(`Order ${idOrder} not found, skipping.`);
      continue;
    }
    const details = await orderDetailsFor(idOrder);
    const cartRules = await orderCartRulesFor(idOrder);
    const activeRules = cartRules.filter((r) => String(r.deleted ?? "0") === "0");

    const result = recomputeOrderTotal(
      details, cartRules, order.total_shipping || "0", order.total_paid_tax_incl || "0"
    );
    if (!(result.is_mismatched || result.invalid_discount_shape)) continue;

    const row = buildReportRow(idOrder, result, activeRules.map((r) => r.id));
    flagged++;
    console.warn(
      `Order ${row.id_order} total mismatch. expected=${row.expected_total.toFixed(2)} ` +
        `reported=${row.reported_total.toFixed(2)} delta=${row.delta.toFixed(2)} ` +
        `invalid_discount_shape=${row.invalid_discount_shape} cart_rules=${JSON.stringify(row.order_cart_rules_summed)}`
    );

    if (!DRY_RUN) {
      await applyCorrection(idOrder, order, result, activeRules);
      console.log(`Order ${idOrder} corrected via PUT /api/orders/${idOrder}.`);
    }
  }

  console.log(
    `Done. ${flagged} order(s) flagged. DRY_RUN=${DRY_RUN} (repair only runs when explicitly false).`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
