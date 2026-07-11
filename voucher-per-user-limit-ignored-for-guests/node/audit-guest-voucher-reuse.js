/**
 * Find PrestaShop "one use per customer" cart rules that a guest checkout redeemed
 * more than once under the same email address.
 *
 * CartRule::checkValidity enforces quantity_per_user by counting prior orders against
 * id_customer. Guest checkout never reuses or merges an existing account by email:
 * every guest order creates a brand new customer record, and therefore a brand new
 * id_customer, even when the same email is entered again. Because that fresh
 * id_customer always shows zero prior uses, quantity_per_user=1 never blocks a repeat
 * guest order under the same email (PrestaShop/PrestaShop #10122, #16370).
 *
 * This script only reports. The optional, DRY_RUN-guarded corrective step only disables
 * further redemptions of the voucher by setting active=0; it never cancels, edits, or
 * refunds an order that already redeemed it. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/prestashop/voucher-per-user-limit-ignored-for-guests/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ERROR_STATE_IDS = new Set([6, 8]); // PS_OS_ERROR, PS_OS_CANCELED (adjust to your store's order_states)

/**
 * Pure decision logic, no I/O.
 *
 * Groups redemptions by (id_cart_rule, email) instead of (id_cart_rule, id_customer),
 * so a guest who checks out repeatedly under the same email with a fresh id_customer
 * each time is still recognized as the same person. Returns a list of entries for any
 * (id_cart_rule, email) pair whose redemption count exceeds quantity_per_user.
 */
export function findOverusedVouchers(cartRules, orderCartRules, orders, customers) {
  const rulesById = new Map(cartRules.map((r) => [Number(r.id), r]));
  const emailByCustomer = new Map(customers.map((c) => [Number(c.id), c.email || ""]));

  const customerByOrder = new Map();
  for (const o of orders) {
    if (ERROR_STATE_IDS.has(Number(o.current_state))) continue;
    if (o.id_customer) customerByOrder.set(Number(o.id), Number(o.id_customer));
  }

  const counts = new Map(); // "idCartRule::email" -> { idCartRule, email, count, idOrders }
  for (const link of orderCartRules) {
    const idCartRule = Number(link.id_cart_rule);
    const idOrder = Number(link.id_order);
    const idCustomer = customerByOrder.get(idOrder);
    if (idCustomer === undefined) continue; // order excluded (error/cancelled) or unknown
    const email = emailByCustomer.get(idCustomer) || "";
    const key = `${idCartRule}::${email}`;
    const entry = counts.get(key) || { idCartRule, email, count: 0, idOrders: [] };
    entry.count += 1;
    entry.idOrders.push(idOrder);
    counts.set(key, entry);
  }

  const flagged = [];
  for (const entry of counts.values()) {
    const rule = rulesById.get(entry.idCartRule);
    if (!rule) continue;
    const quantityPerUser = Number(rule.quantity_per_user);
    if (entry.count > quantityPerUser) {
      flagged.push({
        idCartRule: entry.idCartRule,
        code: rule.code || "",
        email: entry.email,
        quantityPerUser,
        actualUses: entry.count,
        idOrders: [...entry.idOrders].sort((a, b) => a - b),
      });
    }
  }
  flagged.sort((a, b) => a.idCartRule - b.idCartRule || a.email.localeCompare(b.email));
  return flagged;
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

async function limitedCartRules() {
  const data = await apiGet("cart_rules", { "filter[quantity_per_user]": 1, display: "full" });
  const rules = data.cart_rules || [];
  return rules.map((r) => ({
    id: Number(r.id),
    code: r.code || "",
    quantity_per_user: Number(r.quantity_per_user),
    quantity: Number(r.quantity),
  }));
}

async function orderCartRuleLinks(cartRuleId) {
  const data = await apiGet("order_cart_rules", { "filter[id_cart_rule]": cartRuleId, display: "full" });
  const links = data.order_cart_rules || [];
  return links.map((link) => ({ id_cart_rule: cartRuleId, id_order: Number(link.id_order) }));
}

async function getOrder(orderId) {
  const o = (await apiGet(`orders/${orderId}`)).order;
  return {
    id: Number(o.id),
    id_customer: o.id_customer ? Number(o.id_customer) : null,
    current_state: Number(o.current_state),
  };
}

async function getCustomer(customerId) {
  const c = (await apiGet(`customers/${customerId}`)).customer;
  return { id: Number(c.id), email: c.email || "" };
}

async function disableFurtherUse(cartRuleId) {
  const body = { cart_rule: { id: cartRuleId, active: 0 } };
  if (DRY_RUN) {
    console.log(`Dry run: would PUT cart_rules/${cartRuleId}`, body);
    return null;
  }
  return apiPut(`cart_rules/${cartRuleId}`, body);
}

export async function run() {
  const cartRules = await limitedCartRules();

  const allLinks = [];
  const orderIds = new Set();
  for (const rule of cartRules) {
    const links = await orderCartRuleLinks(rule.id);
    allLinks.push(...links);
    for (const link of links) orderIds.add(link.id_order);
  }

  const orders = [];
  for (const orderId of orderIds) orders.push(await getOrder(orderId));

  const customerIds = new Set(orders.filter((o) => o.id_customer).map((o) => o.id_customer));
  const customers = [];
  for (const customerId of customerIds) customers.push(await getCustomer(customerId));

  const report = findOverusedVouchers(cartRules, allLinks, orders, customers);
  if (report.length === 0) {
    console.log(`No per-customer voucher overuse found across ${cartRules.length} limited cart rule(s).`);
    return;
  }

  for (const entry of report) console.warn("Voucher overuse detected:", entry);
  console.log(`Done. ${report.length} overused voucher/email pair(s). Report ready for manual review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
