/**
 * Detect PrestaShop carts and orders still carrying an expired voucher.
 *
 * CartRule::checkValidity() checks a voucher's date_to expiry differently depending on
 * an alreadyInCart flag. When a voucher is already sitting in the cart, that flag is
 * true and the expiry check is effectively bypassed, so a code added before its expiry
 * date stays valid through checkout even if the customer actually pays after date_to has
 * passed. Confirmed in PrestaShop/PrestaShop issues #26235 and #32303. Because the
 * cart-to-order conversion copies the cart_rule association into order_cart_rule at
 * payment time without re-validating dates, and nothing re-scans placed orders
 * afterward, an expired discount can ride all the way into a paid order, leaving the
 * discount shown on the order out of step with the amount actually charged, as reported
 * in issue #34067 and the broader "cart rules are a nest of cockroaches" bug collection
 * in issue #28134.
 *
 * This is a financial and discount-correctness issue, not a safely auto-correctable
 * field, so the default action is to flag every violation for manual finance or
 * merchant review. A DRY_RUN-guarded repair is available for still-open, unpaid carts
 * only: PrestaShop's webservice has no direct cart-cart_rule delete route, so the
 * supported approach is a full resource PUT to /api/carts/{id} with
 * associations.cart_rules omitting the expired id_cart_rule. Already-paid orders are
 * never edited, since that would retroactively alter invoiced totals.
 *
 * Guide: https://www.allanninal.dev/prestashop/expired-voucher-still-applied/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const OPEN_CART_IDS = (process.env.OPEN_CART_IDS || "").split(",").filter(Boolean);

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * recordDate is order.date_add for a placed order, or cart.date_upd for a still-open
 * cart. Returns true (flag as violation) when active is false and the association still
 * exists, or when recordDate falls outside [dateFrom, dateTo], i.e. recordDate > dateTo
 * or recordDate < dateFrom. Returns false when recordDate falls within the inclusive
 * validity window and active is true.
 */
export function isVoucherExpiredForRecord(recordDate, dateFrom, dateTo, active) {
  if (!active) return true;
  if (recordDate > dateTo) return true;
  if (recordDate < dateFrom) return true;
  return false;
}

export function buildCartPutPayload(cart, expiredIdCartRule) {
  const next = { ...cart };
  const associations = { ...(cart.associations || {}) };
  const rules = associations.cart_rules || [];
  associations.cart_rules = rules.filter((r) => String(r.id) !== String(expiredIdCartRule));
  next.associations = associations;
  return next;
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

async function openCarts(cartIds) {
  if (!cartIds.length) return [];
  const ids = cartIds.join(",");
  const data = await apiGet("carts", { "filter[id]": `[${ids}]`, display: "full" });
  return data.carts || [];
}

async function recentOrders() {
  const data = await apiGet("orders", { display: "full" });
  return data.orders || [];
}

async function orderCartRulesFor(idOrder) {
  const data = await apiGet("order_cart_rules", { "filter[id_order]": idOrder, display: "full" });
  return data.order_cart_rules || [];
}

async function cartRuleDetail(idCartRule) {
  const data = await apiGet(`cart_rules/${idCartRule}`);
  return data.cart_rule || {};
}

function toEpoch(value) {
  return Date.parse(String(value).replace(" ", "T")) / 1000;
}

async function scanOrders() {
  const flagged = [];
  for (const order of await recentOrders()) {
    const idOrder = order.id;
    const orderDate = order.date_add;
    if (!orderDate) continue;
    for (const link of await orderCartRulesFor(idOrder)) {
      if (!["0", "False", "false"].includes(String(link.deleted))) continue;
      const rule = await cartRuleDetail(link.id_cart_rule);
      if (!rule || !rule.date_to) continue;
      const violation = isVoucherExpiredForRecord(
        toEpoch(orderDate),
        toEpoch(rule.date_from),
        toEpoch(rule.date_to),
        ["1", "True", "true"].includes(String(rule.active)),
      );
      if (violation) {
        flagged.push({
          id_order: idOrder,
          id_cart_rule: link.id_cart_rule,
          voucher_code: rule.code,
          date_to: rule.date_to,
          record_date: orderDate,
          discount_value: link.value,
        });
      }
    }
  }
  return flagged;
}

async function scanOpenCarts() {
  const flagged = [];
  for (const cart of await openCarts(OPEN_CART_IDS)) {
    const cartDate = cart.date_upd;
    if (!cartDate) continue;
    const rules = (cart.associations && cart.associations.cart_rules) || [];
    for (const link of rules) {
      const rule = await cartRuleDetail(link.id);
      if (!rule || !rule.date_to) continue;
      const violation = isVoucherExpiredForRecord(
        toEpoch(cartDate),
        toEpoch(rule.date_from),
        toEpoch(rule.date_to),
        ["1", "True", "true"].includes(String(rule.active)),
      );
      if (violation) {
        flagged.push({
          id_cart: cart.id,
          id_cart_rule: link.id,
          voucher_code: rule.code,
          date_to: rule.date_to,
          record_date: cartDate,
          cart,
        });
      }
    }
  }
  return flagged;
}

async function repairOpenCart(row) {
  const payload = buildCartPutPayload(row.cart, row.id_cart_rule);
  console.log(
    `${DRY_RUN ? "DRY RUN" : "REPAIRING"} cart ${row.id_cart}: would PUT associations.cart_rules without id_cart_rule=${row.id_cart_rule}`
  );
  if (!DRY_RUN) await apiPut(`carts/${row.id_cart}`, payload);
}

export async function run() {
  const orderViolations = await scanOrders();
  for (const row of orderViolations) {
    console.warn(
      `Expired voucher on PAID order (report only). id_order=${row.id_order} id_cart_rule=${row.id_cart_rule} ` +
        `code=${row.voucher_code} date_to=${row.date_to} order_date=${row.record_date} discount_value=${row.discount_value}`
    );
  }

  const cartViolations = await scanOpenCarts();
  for (const row of cartViolations) {
    console.warn(
      `Expired voucher on OPEN cart. id_cart=${row.id_cart} id_cart_rule=${row.id_cart_rule} ` +
        `code=${row.voucher_code} date_to=${row.date_to} cart_date=${row.record_date}`
    );
    if (OPEN_CART_IDS.length) await repairOpenCart(row);
  }

  console.log(
    `Done. ${orderViolations.length} paid order violation(s) flagged for finance review, ` +
      `${cartViolations.length} open cart violation(s) found ` +
      `(${DRY_RUN ? "would repair" : OPEN_CART_IDS.length ? "repaired" : "report only"}).`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
