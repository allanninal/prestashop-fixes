/**
 * Find and remove orphaned PrestaShop stock_available rows left behind
 * after a product combination is deleted.
 *
 * There is no enforced cascade between combinations (product_attribute) and
 * stock_available, so deleting a combination through the Back Office or the
 * combinations webservice resource can leave its stock row behind. The Back
 * Office sums quantity across every stock_available row tied to a product, so
 * an orphan row with nonzero quantity silently inflates the displayed total
 * stock. This lists live combinations and all stock rows for a product, finds
 * rows whose id_product_attribute matches no live combination, and deletes
 * them only after re-confirming on a fresh fetch immediately beforehand.
 * Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/prestashop/orphaned-stock-rows-after-combination-delete/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = (process.env.PRESTASHOP_URL || "https://example.test").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "dummy_key";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const PRODUCT_IDS = (process.env.PRODUCT_IDS || "").split(",").map((p) => p.trim()).filter(Boolean).map(Number);

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

async function liveCombinations(idProduct) {
  const data = await apiGet("combinations", { display: "full", "filter[id_product]": idProduct });
  return data.combinations || [];
}

async function stockRowsForProduct(idProduct) {
  const data = await apiGet("stock_availables", { display: "full", "filter[id_product]": idProduct });
  const rows = data.stock_availables || [];
  return rows.map((r) => ({
    id: Number(r.id),
    id_product_attribute: Number(r.id_product_attribute || 0),
    quantity: Number(r.quantity || 0),
    out_of_stock: Number(r.out_of_stock || 0),
    id_shop: Number(r.id_shop || 0),
  }));
}

/**
 * Pure decision logic, no I/O.
 *
 * combinations: array of objects from GET /api/combinations?filter[id_product]=X
 *               (each with at least "id").
 * stockRows: array of objects from GET /api/stock_availables?filter[id_product]=X
 *            (each with "id", "id_product_attribute", "quantity", "out_of_stock").
 *
 * Returns the stock rows whose id_product_attribute matches no live
 * combination and is not 0 (0 is the base product's own stock row, which
 * always survives regardless of combinations).
 */
export function findOrphanStockRows(combinations, stockRows) {
  const liveIds = new Set([0, ...combinations.map((c) => Number(c.id))]);
  return stockRows.filter((row) => !liveIds.has(Number(row.id_product_attribute)));
}

async function deleteStockRow(idStockAvailable) {
  const res = await fetch(`${BASE_URL}/api/stock_availables/${idStockAvailable}`, {
    method: "DELETE",
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
}

export async function run() {
  let totalOrphanQuantity = 0;
  let removed = 0;

  for (const idProduct of PRODUCT_IDS) {
    const combinations = await liveCombinations(idProduct);
    const stockRows = await stockRowsForProduct(idProduct);
    const orphans = findOrphanStockRows(combinations, stockRows);

    for (const orphan of orphans) {
      totalOrphanQuantity += orphan.quantity;
      console.warn(
        `Product ${idProduct} orphan stock row id=${orphan.id} id_product_attribute=${orphan.id_product_attribute} quantity=${orphan.quantity} id_shop=${orphan.id_shop} (${DRY_RUN ? "would delete" : "deleting"})`
      );
      if (!DRY_RUN) {
        // Re-fetch and re-diff right before deleting, to avoid a race
        // with a combination created between detection and repair.
        const freshCombinations = await liveCombinations(idProduct);
        const freshRows = await stockRowsForProduct(idProduct);
        const stillOrphanIds = new Set(findOrphanStockRows(freshCombinations, freshRows).map((o) => o.id));
        if (stillOrphanIds.has(orphan.id)) {
          await deleteStockRow(orphan.id);
          removed++;
        }
      } else {
        removed++;
      }
    }
  }

  console.log(`Done. ${removed} orphan row(s) ${DRY_RUN ? "to delete" : "deleted"}, ${totalOrphanQuantity} unit(s) of orphaned quantity found.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
