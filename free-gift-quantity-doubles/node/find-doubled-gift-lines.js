/**
 * Find PrestaShop carts where an automatic free-gift line ended up at quantity 2 or
 * more after an unrelated cart item was removed.
 *
 * An automatic free-gift cart rule (no voucher code, gift_product and
 * gift_product_attribute set) is re-evaluated by Cart::updateQty() on every cart
 * mutation. When the qualifying line item is removed, PrestaShop first drops the
 * cart's applicable cart rules, recalculates them, and re-adds the gift row through
 * the same "up" quantity operator used for normal products. Because the gift's
 * existing ps_cart_product row (quantity 1, is_gift=1) has not been cleaned up yet at
 * that point, the increment adds 1 to the existing row instead of inserting a fresh
 * one, leaving the gift line at quantity 2 with no cart rule authorizing more than one
 * free unit. Tracked upstream as PrestaShop/PrestaShop#22270, fixed in 1.7.7.0; the
 * same class of desync can still recur in forks or custom modules on older codebases.
 *
 * This script only reports. The optional, DRY_RUN-guarded corrective step only resets
 * the quantity to 1 on a cart row confirmed to be a pure gift line (no separate
 * non-gift row for the same product/attribute exists in the same cart); it never
 * touches a cart row that also carries a genuinely purchased quantity of the same
 * product. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/prestashop/free-gift-quantity-doubles/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DATE_FROM = process.env.DATE_FROM || "2026-07-01";
const DATE_TO = process.env.DATE_TO || "2026-07-11";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * cartRows: [{idProduct, idProductAttribute, quantity}, ...]
 * giftRules: [{idCartRule, giftProduct, giftProductAttribute, code}, ...]
 *
 * Returns a list of finding objects: {idProduct, idProductAttribute, quantity,
 *   idCartRule, isAutomatic}. Rows with quantity <= 1, or with no matching gift rule,
 *   are excluded. isAutomatic is true when the matching rule's code is empty, matching
 *   the reported bug's no-code path.
 *
 * Pure function: no I/O, takes plain arrays/objects, returns a plain array.
 */
export function findDoubledGiftLines(cartRows, giftRules) {
  const giftLookup = new Map();
  for (const rule of giftRules) {
    if (rule.giftProduct <= 0) continue;
    giftLookup.set(`${rule.giftProduct}:${rule.giftProductAttribute}`, rule);
  }

  const findings = [];
  for (const row of cartRows) {
    if (row.quantity <= 1) continue;
    const rule = giftLookup.get(`${row.idProduct}:${row.idProductAttribute}`);
    if (!rule) continue;
    findings.push({
      idProduct: row.idProduct,
      idProductAttribute: row.idProductAttribute,
      quantity: row.quantity,
      idCartRule: rule.idCartRule,
      isAutomatic: rule.code === "",
    });
  }
  return findings;
}

/**
 * True only when the doubled quantity is explained entirely by the gift row, i.e.
 * there is no separate non-gift row for the same product/attribute in this cart that
 * would make a quantity rewrite destroy a legitimately purchased unit.
 */
export function isPureGiftRow(cartRows, idProduct, idProductAttribute, giftQuantity) {
  const matching = cartRows.filter(
    (r) => r.idProduct === idProduct && r.idProductAttribute === idProductAttribute
  );
  return matching.length === 1 && matching[0].quantity === giftQuantity;
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

async function openCarts(dateFrom, dateTo, limit = "0,200") {
  const data = await apiGet("carts", {
    display: "full",
    "filter[date_upd]": `[${dateFrom},${dateTo}]`,
    limit,
  });
  return data.carts || [];
}

function cartRowsOf(cart) {
  const rows = cart.associations?.cart_rows || [];
  return rows.map((row) => ({
    idProduct: Number(row.id_product),
    idProductAttribute: Number(row.id_product_attribute || 0),
    quantity: Number(row.quantity),
  }));
}

async function giftGrantingCartRules() {
  const data = await apiGet("cart_rules", { display: "full", "filter[active]": "1" });
  const rules = data.cart_rules || [];
  const out = [];
  for (const rule of rules) {
    const giftProduct = Number(rule.gift_product || 0);
    if (giftProduct <= 0) continue;
    out.push({
      idCartRule: Number(rule.id),
      giftProduct,
      giftProductAttribute: Number(rule.gift_product_attribute || 0),
      code: rule.code || "",
    });
  }
  return out;
}

async function correctGiftQuantity(cartId, cart, idProduct, idProductAttribute) {
  const body = { cart: { ...cart } };
  const rows = body.cart.associations?.cart_rows || [];
  for (const row of rows) {
    if (Number(row.id_product) === idProduct && Number(row.id_product_attribute || 0) === idProductAttribute) {
      row.quantity = 1;
    }
  }
  if (DRY_RUN) {
    console.log(`Dry run: would PUT carts/${cartId} to reset product ${idProduct} quantity to 1`);
    return null;
  }
  return apiPut(`carts/${cartId}`, body);
}

export async function run() {
  const giftRules = await giftGrantingCartRules();
  const carts = await openCarts(DATE_FROM, DATE_TO);

  let totalFindings = 0;
  for (const cart of carts) {
    const cartId = Number(cart.id);
    const rows = cartRowsOf(cart);
    const findings = findDoubledGiftLines(rows, giftRules);
    for (const finding of findings) {
      totalFindings++;
      console.warn(
        `Cart ${cartId}: product ${finding.idProduct} (attribute ${finding.idProductAttribute}) at quantity ${finding.quantity}, granted by cart rule ${finding.idCartRule} (automatic=${finding.isAutomatic})`
      );
      if (isPureGiftRow(rows, finding.idProduct, finding.idProductAttribute, finding.quantity)) {
        await correctGiftQuantity(cartId, cart, finding.idProduct, finding.idProductAttribute);
      } else {
        console.warn(`Cart ${cartId}: product ${finding.idProduct} has another non-gift row too, skipping automatic correction`);
      }
    }
  }
  console.log(`Done. ${totalFindings} doubled gift line(s) found.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
