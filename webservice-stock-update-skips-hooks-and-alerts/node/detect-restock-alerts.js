/**
 * Detect restocks that a PrestaShop webservice write will never announce on its own.
 *
 * A webservice PATCH or PUT to stock_availables updates the quantity through a plain ORM
 * save. It never calls the admin product controller or StockAvailable business logic that
 * core hooks like actionUpdateQuantity are wired to, so the back in stock alert module,
 * and any custom module listening on that hook, never runs. The number in the database is
 * correct; nothing downstream of the hook ever finds out.
 *
 * This script keeps its own record of the last quantity seen per product, reads the real
 * current quantity from stock_availables after any update, and flags a genuine restock
 * notification only when an active, visible product moves from zero or below to a positive
 * quantity. It never sends the alert itself, it hands the id_product to your own mailer,
 * queue, or task tracker, since content and subscriber handling belong to your system.
 *
 * Guide: https://www.allanninal.dev/prestashop/webservice-stock-update-skips-hooks-and-alerts/
 */
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const LAST_SEEN_PATH = process.env.LAST_SEEN_PATH || "last_seen_quantities.json";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * previousQuantity: the quantity this script last recorded for the product, or null
 *   if this is the first time it has seen the product.
 * currentQuantity: the real quantity read from stock_availables right now, or null
 *   if no stock_availables row was found.
 * isActive, visibility: the product's active flag and visibility ("both"/"catalog"/
 *   "search"/"none").
 *
 * Returns a decision object. The caller is responsible for driving any actual
 * notification; this function only ever decides whether one is warranted.
 */
export function decideRestockAlert(previousQuantity, currentQuantity, isActive, visibility) {
  if (previousQuantity == null) {
    return { action: "record_only", reason: "no prior quantity on file yet" };
  }

  if (currentQuantity == null) {
    return { action: "record_only", reason: "no stock_availables row to compare" };
  }

  const becamePositive = previousQuantity <= 0 && currentQuantity > 0;
  if (!becamePositive) {
    return { action: "record_only", reason: "not a zero to positive transition" };
  }

  if (!isActive || visibility === "none") {
    return { action: "record_only", reason: "product is inactive or not visible" };
  }

  return { action: "flag_restock_alert", reason: "active, visible product went from zero to positive stock" };
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function currentQuantity(idProduct, idProductAttribute = 0) {
  const data = await apiGet("stock_availables", {
    "filter[id_product]": idProduct,
    "filter[id_product_attribute]": idProductAttribute,
    display: "full",
  });
  const rows = data.stock_availables || [];
  return rows.length ? Number(rows[0].quantity) : null;
}

async function productStatus(idProduct) {
  const data = await apiGet(`products/${idProduct}`, { display: "full" });
  const product = data.product || {};
  return { isActive: String(product.active) === "1", visibility: product.visibility || "both" };
}

function loadLastSeen(path) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [Number(k), v]));
  } catch {
    return {};
  }
}

function saveLastSeen(path, lastSeen) {
  writeFileSync(path, JSON.stringify(lastSeen));
}

function notifyRestock(idProduct, qty) {
  // Plug in your own mailer, queue, or task tracker here.
  // This keeps the script honest about not owning your notification content.
  console.log(`Restock alert needed for product ${idProduct}, quantity now ${qty}.`);
}

export async function run(trackedProductIds) {
  const lastSeen = loadLastSeen(LAST_SEEN_PATH);
  let flagged = 0;

  for (const idProduct of trackedProductIds) {
    const previousQuantity = idProduct in lastSeen ? lastSeen[idProduct] : null;
    const quantity = await currentQuantity(idProduct);
    const { isActive, visibility } = await productStatus(idProduct);

    const decision = decideRestockAlert(previousQuantity, quantity, isActive, visibility);

    if (decision.action === "flag_restock_alert") {
      flagged++;
      console.warn(`Product ${idProduct}: ${decision.reason}`);
      if (!DRY_RUN) notifyRestock(idProduct, quantity);
    }

    if (quantity !== null) lastSeen[idProduct] = quantity;
  }

  saveLastSeen(LAST_SEEN_PATH, lastSeen);
  console.log(`Done. ${flagged} restock(s) ${DRY_RUN ? "to notify" : "notified"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tracked = (process.env.TRACKED_PRODUCT_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number);
  run(tracked).catch((err) => { console.error(err); process.exit(1); });
}
