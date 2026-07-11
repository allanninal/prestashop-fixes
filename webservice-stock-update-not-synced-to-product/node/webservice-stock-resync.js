/**
 * Find and repair PrestaShop webservice stock updates that never reached product.quantity.
 *
 * Since PrestaShop 1.5, real stock lives in stock_available.quantity, while product.quantity
 * on the products resource is a deprecated, denormalized column kept only for backward
 * compatible SQL and exports. A correct PUT to stock_availables updates the true stock but
 * does not always refresh that cached column, so product.quantity can sit stale or stuck at
 * zero. This pulls both values per product and combination, flags any pair that disagrees,
 * and repairs it by reposting the stock_availables row's own unchanged quantity, which forces
 * PrestaShop's internal Product::updateQuantity() hook to recompute the cache. Never writes
 * to the products resource to fix quantity. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/prestashop/webservice-stock-update-not-synced-to-product/
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

async function productIds(limit = "0,50") {
  const data = await apiGet("products", { display: "[id]", limit });
  const products = data.products || [];
  return products.map((p) => Number(p.id));
}

async function productCachedQuantity(idProduct) {
  const data = await apiGet(`products/${idProduct}`, {});
  return Number(data.product.quantity || 0);
}

async function stockAvailableRow(idProduct, idProductAttribute = 0) {
  const data = await apiGet("stock_availables", {
    "filter[id_product]": idProduct,
    "filter[id_product_attribute]": idProductAttribute,
    display: "full",
  });
  const rows = data.stock_availables || [];
  if (!rows.length) return null;
  const row = rows[0];
  return {
    id_stock_available: Number(row.id),
    id_product: Number(row.id_product),
    id_product_attribute: Number(row.id_product_attribute || 0),
    quantity: Number(row.quantity || 0),
    out_of_stock: Number(row.out_of_stock || 0),
    depends_on_stock: Number(row.depends_on_stock || 0),
  };
}

/**
 * Pure decision. Never mutates state; caller performs the actual write/report.
 */
export function decideReconciliation(productQty, stockAvailQty, outOfStock, dependsOnStock) {
  const delta = stockAvailQty - productQty;

  if (delta === 0) {
    return { status: "in_sync", action: "none", delta: 0 };
  }

  if (productQty === 0 && stockAvailQty > 0) {
    const action = dependsOnStock === 1 ? "resync_display_only" : "flag_for_review";
    return { status: "stuck_zero", action, delta };
  }

  const action = dependsOnStock === 1 ? "resync_display_only" : "flag_for_review";
  return { status: "stale_product_field", action, delta };
}

async function resyncStockAvailable(row) {
  const url = new URL(`${BASE_URL}/api/stock_availables/${row.id_stock_available}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      stock_available: {
        id: row.id_stock_available,
        id_product: row.id_product,
        id_product_attribute: row.id_product_attribute,
        quantity: row.quantity,
      },
    }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

export async function run() {
  let checked = 0;
  let resynced = 0;
  let flagged = 0;

  for (const idProduct of await productIds()) {
    const row = await stockAvailableRow(idProduct, 0);
    if (!row) continue;
    const productQty = await productCachedQuantity(idProduct);
    checked++;

    const decision = decideReconciliation(productQty, row.quantity, row.out_of_stock, row.depends_on_stock);
    if (decision.status === "in_sync") continue;

    console.warn(
      `Product ${idProduct}: product.quantity=${productQty} stock_available.quantity=${row.quantity} status=${decision.status} action=${decision.action}`
    );

    if (decision.action === "resync_display_only") {
      if (!DRY_RUN) await resyncStockAvailable(row);
      resynced++;
    } else if (decision.action === "flag_for_review") {
      flagged++;
    }
  }

  console.log(
    `Done. ${checked} product(s) checked, ${resynced} ${DRY_RUN ? "to resync" : "resynced"}, ${flagged} flagged for manual review.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
