/**
 * Find PrestaShop single-use cart rules that were redeemed on more orders than their
 * quantity or quantity_per_user allows.
 *
 * CartRule::checkValidity reads a voucher's remaining quantity and a customer's prior
 * quantity_per_user usage at apply time and again at order validation, but those reads
 * and writes are not wrapped in a locking transaction. Under concurrent checkouts, two
 * orders can each pass the check before either one's validation decrements the used
 * count, so a single-use voucher can end up referenced by more than one paid order.
 * quantity_per_user is also checked against id_customer, so guest checkouts can bypass
 * the per-user cap.
 *
 * This script only reports. The optional, DRY_RUN-guarded corrective step only disables
 * further use of the voucher by setting quantity to 0; it never cancels, edits, or
 * refunds an order that already used it. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/prestashop/voucher-redeemed-beyond-quantity-limit/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const CART_RULE_ID = Number(process.env.CART_RULE_ID || 42);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const VALID_STATE_IDS = new Set([2, 3, 4, 5]); // payment accepted, processing, shipped, delivered

/**
 * cartRule: {id, code, quantity, quantityPerUser}
 * ordersUsingRule: [{idOrder, idCustomer, currentState, dateAdd}, ...] pre-filtered to
 *   only orders whose state is a "valid" (paid/processing/shipped) order_state.
 *
 * Returns null if no overage, else {cartRuleId, code, quantityLimit, totalUses,
 *   overageCount, offendingOrderIds, perUserViolations: {idCustomer: count}}.
 *
 * Decision logic: count total valid orders referencing the rule vs cartRule.quantity;
 * group by idCustomer and compare each group's count vs quantityPerUser; flag if
 * either cap is exceeded.
 */
export function findVoucherOveruse(cartRule, ordersUsingRule) {
  const totalUses = ordersUsingRule.length;
  const perUserCounts = new Map();
  for (const order of ordersUsingRule) {
    const cust = order.idCustomer;
    perUserCounts.set(cust, (perUserCounts.get(cust) || 0) + 1);
  }

  const perUserViolations = {};
  for (const [cust, count] of perUserCounts) {
    if (count > cartRule.quantityPerUser) perUserViolations[cust] = count;
  }

  const totalOverage = totalUses > cartRule.quantity;
  if (!totalOverage && Object.keys(perUserViolations).length === 0) return null;

  const offendingOrderIds = ordersUsingRule.map((o) => o.idOrder).sort((a, b) => a - b);
  return {
    cartRuleId: cartRule.id,
    code: cartRule.code,
    quantityLimit: cartRule.quantity,
    totalUses,
    overageCount: Math.max(0, totalUses - cartRule.quantity),
    offendingOrderIds,
    perUserViolations,
  };
}

function authHeader() {
  return "Basic " + Buffer.from(`${WS_KEY}:`).toString("base64");
}

async function apiGet(path, params = {}) {
  const qs = new URLSearchParams({ ...params, output_format: "JSON" });
  const res = await fetch(`${BASE_URL}/api/${path}?${qs}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(`${BASE_URL}/api/${path}?output_format=JSON`, {
    method: "PUT",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function getCartRule(cartRuleId) {
  const data = await apiGet(`cart_rules/${cartRuleId}`);
  const rule = data.cart_rule;
  return {
    id: Number(rule.id),
    code: rule.code || "",
    quantity: Number(rule.quantity),
    quantityPerUser: Number(rule.quantity_per_user),
  };
}

async function ordersUsingRule(cartRuleId) {
  const data = await apiGet("order_cart_rules", { "filter[id_cart_rule]": cartRuleId, display: "full" });
  const links = data.order_cart_rules || [];
  const rows = [];
  for (const link of links) {
    const orderId = Number(link.id_order);
    const order = (await apiGet(`orders/${orderId}`, { display: "full" })).order;
    rows.push({
      idOrder: orderId,
      idCustomer: order.id_customer ? Number(order.id_customer) : null,
      currentState: Number(order.current_state),
      dateAdd: order.date_add,
    });
  }
  return rows.filter((r) => VALID_STATE_IDS.has(r.currentState));
}

async function disableFurtherUse(cartRuleId) {
  const body = { cart_rule: { id: cartRuleId, quantity: 0 } };
  if (DRY_RUN) {
    console.log(`Dry run: would PUT cart_rules/${cartRuleId}`, body);
    return null;
  }
  return apiPut(`cart_rules/${cartRuleId}`, body);
}

export async function run() {
  const cartRule = await getCartRule(CART_RULE_ID);
  const validOrders = await ordersUsingRule(CART_RULE_ID);

  const report = findVoucherOveruse(cartRule, validOrders);
  if (report === null) {
    console.log(`Cart rule ${cartRule.id} (${cartRule.code}) is within its quantity and quantity_per_user limits.`);
    return;
  }

  console.warn("Voucher overuse detected:", report);
  await disableFurtherUse(CART_RULE_ID);
  console.log("Done. Report ready for manual review.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
