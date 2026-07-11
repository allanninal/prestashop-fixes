/**
 * Detect and repair PrestaShop PATCH writes to stock_availables that get silently dropped.
 *
 * PrestaShop's webservice sits behind Apache mod_rewrite and often a reverse proxy or CDN.
 * A PATCH to /api/stock_availables/{id} that does not match the exact expected URL can
 * trigger a 301 or 302 redirect, and most HTTP clients replay that redirect as a GET and
 * drop the body. The server then returns 200 for a read, not your write, so the quantity
 * never actually changes even though nothing errored. This reads the quantity before the
 * write, sends the PATCH while watching for a redirect and a method change, re-reads right
 * after, and only falls back to a full PUT once a drop is confirmed. It never blindly
 * retries the same PATCH. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/prestashop/stock-patch-silently-dropped/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = (process.env.PRESTASHOP_URL || "https://example.test").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "dummy_key";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function authHeader() {
  return "Basic " + Buffer.from(`${WS_KEY}:`).toString("base64");
}

function stockAvailableUrl(idStockAvailable) {
  return `${BASE_URL}/api/stock_availables/${idStockAvailable}`;
}

async function readStockAvailable(idStockAvailable) {
  const url = new URL(stockAvailableUrl(idStockAvailable));
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  const body = await res.json();
  const row = body.stock_available;
  return {
    id_stock_available: Number(row.id),
    id_product: Number(row.id_product || 0),
    id_product_attribute: Number(row.id_product_attribute || 0),
    id_shop: Number(row.id_shop || 1),
    quantity: Number(row.quantity || 0),
    depends_on_stock: Number(row.depends_on_stock || 0),
    out_of_stock: Number(row.out_of_stock || 0),
  };
}

async function patchQuantity(idStockAvailable, newQty) {
  const url = new URL(stockAvailableUrl(idStockAvailable));
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PATCH",
    redirect: "manual",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ stock_available: { id: idStockAvailable, quantity: String(newQty) } }),
  });
  const redirected = res.type === "opaqueredirect" || REDIRECT_CODES.has(res.status);
  const finalMethod = redirected ? "GET" : "PATCH";
  return { statusCode: res.status, redirected, finalMethod };
}

/**
 * Pure decision logic, no I/O. Given the quantity read before the write, the quantity
 * the caller attempted to set, the quantity read immediately after the write, whether
 * the HTTP client followed a redirect, and the HTTP method that was actually applied,
 * return one of: "applied", "silently_dropped_redirect", "silently_dropped_other", "no_op".
 */
export function decideWriteStatus(preQty, attemptedQty, postQty, redirected, finalMethod) {
  if (attemptedQty === preQty) return "no_op";
  if (postQty === attemptedQty) return "applied";
  if (redirected && finalMethod.toUpperCase() === "GET") return "silently_dropped_redirect";
  return "silently_dropped_other";
}

async function putFallback(row, newQty) {
  const url = new URL(stockAvailableUrl(row.id_stock_available));
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      stock_available: {
        id: row.id_stock_available,
        id_product: row.id_product,
        id_product_attribute: row.id_product_attribute,
        id_shop: row.id_shop,
        quantity: String(newQty),
        depends_on_stock: row.depends_on_stock,
        out_of_stock: row.out_of_stock,
      },
    }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function guardWrite(idStockAvailable, newQty) {
  const preRow = await readStockAvailable(idStockAvailable);
  const preQty = preRow.quantity;

  const patchResult = await patchQuantity(idStockAvailable, newQty);
  const postRow = await readStockAvailable(idStockAvailable);
  const postQty = postRow.quantity;

  const status = decideWriteStatus(preQty, newQty, postQty, patchResult.redirected, patchResult.finalMethod);

  const record = {
    id_stock_available: idStockAvailable,
    id_product: preRow.id_product,
    id_product_attribute: preRow.id_product_attribute,
    id_shop: preRow.id_shop,
    old_qty: preQty,
    attempted_new_qty: newQty,
    status,
  };

  if (status === "applied" || status === "no_op") {
    console.log(`Stock ${idStockAvailable}: ${status} (qty ${preQty} to ${postQty})`);
    return record;
  }

  console.warn(
    `Stock ${idStockAvailable}: PATCH ${status} (qty stayed ${postQty}, wanted ${newQty}). ${DRY_RUN ? "flagged, needs manual PUT retry" : "falling back to PUT"}`
  );

  if (!DRY_RUN) {
    await putFallback(postRow, newQty);
    const verifyRow = await readStockAvailable(idStockAvailable);
    record.status = verifyRow.quantity === newQty ? "applied" : "still_dropped";
    record.post_qty = verifyRow.quantity;
  }

  return record;
}

export async function run(writes) {
  let applied = 0;
  let flagged = 0;
  for (const [idStockAvailable, newQty] of writes) {
    const record = await guardWrite(idStockAvailable, newQty);
    if (record.status === "applied") applied++;
    else if (["silently_dropped_redirect", "silently_dropped_other", "still_dropped"].includes(record.status)) flagged++;
  }
  console.log(
    `Done. ${applied} write(s) applied, ${flagged} ${DRY_RUN ? "flagged: PATCH silently dropped, needs manual PUT retry" : "still needing review"}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Example: guardWrite a single stock_available id against a target quantity.
  // Replace with your own source of [idStockAvailable, newQty] pairs.
  run([]).catch((err) => { console.error(err); process.exit(1); });
}
