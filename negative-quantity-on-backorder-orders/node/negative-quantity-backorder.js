/**
 * Find and repair negative PrestaShop stock quantities from backorder paid orders.
 *
 * PrestaShop decrements ps_stock_available.quantity at order validation without a
 * transactional row lock tied to the final payment confirmation. When a product allows
 * backorders, or stock enforcement is momentarily bypassed, concurrent checkouts or an
 * order passing through a backorder paid state can each subtract from an already-zero or
 * already-reserved line, driving quantity below zero with nothing in core to self heal it.
 *
 * This pulls every negative stock_availables row, cross-references the orders and order
 * states that plausibly caused it, and classifies each row as no correction needed, safe
 * to clamp to zero, or needing a human to reconcile stock or trigger a reorder. Only the
 * clamp rows are ever written, and only quantity changes. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/prestashop/negative-quantity-on-backorder-orders/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = (process.env.PRESTASHOP_URL || "https://example.test").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "dummy_key";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function authHeader() {
  return "Basic " + Buffer.from(`${WS_KEY}:`).toString("base64");
}

async function apiGet(path, params) {
  const url = new URL(`${BASE_URL}/api/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function negativeStockRows() {
  const data = await apiGet("stock_availables", { display: "full", limit: "0,1000" });
  const rows = data.stock_availables || [];
  return rows
    .map((r) => ({
      id: Number(r.id),
      id_product: Number(r.id_product),
      id_product_attribute: Number(r.id_product_attribute || 0),
      quantity: Number(r.quantity || 0),
      out_of_stock: Number(r.out_of_stock || 0),
      depends_on_stock: String(r.depends_on_stock) === "1" || r.depends_on_stock === true,
    }))
    .filter((r) => r.quantity < 0);
}

async function orderDetailsForProduct(idProduct) {
  const data = await apiGet("order_details", { display: "full", "filter[product_id]": idProduct });
  return data.order_details || [];
}

async function orderById(idOrder) {
  const data = await apiGet(`orders/${idOrder}`, { display: "full" });
  return data.order || {};
}

async function orderStateById(idOrderState) {
  const data = await apiGet(`order_states/${idOrderState}`, { display: "full" });
  return data.order_state || {};
}

// Check whether any order line for this product sits on a paid, backorder-named
// order state with a negative product_quantity, meaning real oversell demand is
// still open against this product.
async function hasOpenBackorderPaidOrder(idProduct) {
  for (const line of await orderDetailsForProduct(idProduct)) {
    const order = await orderById(line.id_order);
    const state = await orderStateById(order.current_state);
    const paid = String(state.paid) === "1" || state.paid === true;
    const name = String(state.name || "");
    const productQuantity = Number(line.product_quantity || 0);
    if (paid && name.toLowerCase().includes("backorder") && productQuantity < 0) return true;
  }
  return false;
}

/**
 * Decide the corrected stock_availables.quantity and an action tag, given the
 * current (possibly negative) quantity and the product's backorder policy.
 *
 * outOfStockPolicy: 0 = deny, 1 = allow (backorder), 2 = use global default
 * Returns [newQuantity, action] where action is "noop", "clamp_to_zero", or "flag_manual_review".
 *
 * Decision logic:
 * - If quantity >= 0: no correction needed -> [quantity, "noop"].
 * - If quantity < 0 and dependsOnStock is false: PrestaShop is not tracking this
 *   stock line for decrement purposes, so leave the number alone but flag it,
 *   since a negative value there is meaningless -> [quantity, "flag_manual_review"].
 * - If quantity < 0 and outOfStockPolicy === 1 (backorders explicitly allowed)
 *   and there is a genuine open backorder-paid order still awaiting fulfillment:
 *   the negative number is an accurate signal of oversell depth, so do not
 *   silently zero it out (that would erase real backorder demand) -> flag it
 *   for a human/replenishment workflow -> [quantity, "flag_manual_review"].
 * - If quantity < 0 and (outOfStockPolicy === 0, i.e. backorders should have
 *   been denied) or there is no matching open backorder-paid order to justify
 *   the deficit: this is drift/corruption (e.g. from the race-condition bug in
 *   PrestaShop #18700/#27631), so normalize it to the floor -> [0, "clamp_to_zero"].
 */
export function clampNegativeStock(quantity, dependsOnStock, outOfStockPolicy, hasPendingBackorderPaid) {
  if (quantity >= 0) return [quantity, "noop"];
  if (!dependsOnStock) return [quantity, "flag_manual_review"];
  if (outOfStockPolicy === 1 && hasPendingBackorderPaid) return [quantity, "flag_manual_review"];
  return [0, "clamp_to_zero"];
}

async function clampStockRowToZero(idStockAvailable) {
  // Fetch the schema first, then only patch quantity, leaving every other
  // field on the row untouched, matching the documented webservice contract.
  await apiGet("stock_availables", { schema: "synopsis" });
  const current = await apiGet(`stock_availables/${idStockAvailable}`, { display: "full" });
  const row = current.stock_available || {};
  row.quantity = 0;
  if (DRY_RUN) {
    console.log(`[DRY RUN] would set stock_availables/${idStockAvailable} quantity -> 0`);
    return null;
  }
  const url = new URL(`${BASE_URL}/api/stock_availables/${idStockAvailable}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ stock_available: row }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

export async function run() {
  const rows = await negativeStockRows();
  let clamped = 0;
  let flagged = 0;
  for (const row of rows) {
    const hasBackorder = await hasOpenBackorderPaidOrder(row.id_product);
    const [, action] = clampNegativeStock(row.quantity, row.depends_on_stock, row.out_of_stock, hasBackorder);
    if (action === "noop") continue;
    if (action === "flag_manual_review") {
      console.warn(
        `Flag for review: stock_available ${row.id} product ${row.id_product} attribute ${row.id_product_attribute} quantity ${row.quantity}`
      );
      flagged++;
      continue;
    }
    console.warn(
      `Drift: stock_available ${row.id} product ${row.id_product} attribute ${row.id_product_attribute} quantity ${row.quantity} -> 0 (${DRY_RUN ? "would clamp" : "clamping"})`
    );
    if (!DRY_RUN) await clampStockRowToZero(row.id);
    clamped++;
  }
  console.log(`Done. ${clamped} row(s) ${DRY_RUN ? "to clamp" : "clamped"}, ${flagged} row(s) flagged for manual review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
