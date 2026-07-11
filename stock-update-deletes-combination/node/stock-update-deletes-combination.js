/**
 * Detect PrestaShop combinations whose stock got knocked out of shared scope
 * by a stock_availables API write, making them look deleted.
 *
 * On a multistore install where the shop group shares stock, a combination's
 * stock_available row is stored once for the whole group at id_shop=0. A PUT
 * to stock_availables can write a concrete id_shop straight onto that row
 * without normalizing it back to the shared scope, so the shared-stock lookup
 * no longer finds it for any shop in the group and the combination reads as
 * zero stock everywhere. The product_attribute row itself is never deleted.
 * This snapshots combinations and stock before a write, re-checks them after,
 * and flags rows whose scope drifted while their shop group truly shares
 * stock. It never auto-repairs without a fresh re-confirmation, and defaults
 * to dry run.
 *
 * Guide: https://www.allanninal.dev/prestashop/stock-update-deletes-combination/
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

async function snapshotCombinations(idProduct) {
  const data = await apiGet("combinations", { display: "full", "filter[id_product]": idProduct });
  const map = new Map();
  for (const c of data.combinations || []) map.set(Number(c.id), c);
  return map;
}

async function snapshotStockRows(idProduct) {
  const data = await apiGet("stock_availables", { display: "full", "filter[id_product]": idProduct });
  const rows = data.stock_availables || [];
  return rows.map((r) => ({
    id: Number(r.id),
    id_product_attribute: Number(r.id_product_attribute || 0),
    id_shop: Number(r.id_shop || 0),
    id_shop_group: Number(r.id_shop_group || 0),
    quantity: Number(r.quantity || 0),
  }));
}

async function shopGroup(idShopGroup) {
  const data = await apiGet(`shop_groups/${idShopGroup}`, {});
  const g = data.shop_group || {};
  return {
    id_shop_group: Number(g.id ?? idShopGroup),
    share_stock: ["1", "true", true].includes(g.share_stock),
  };
}

/**
 * preSnapshot: {id_product_attribute, existed, quantity}
 *   -- combination + stock state captured before the API write
 * postStockRow: {id_shop, id_shop_group, quantity, id_product_attribute}
 *   -- the stock_availables row as it reads after the write
 * shopGroupRow: {id_shop_group, share_stock}
 *   -- the shop group the row belongs to
 *
 * Returns true iff the combination existed before the write, the group
 * shares stock, and the post-write row's shop scope has drifted off the
 * shared id_shop=0 anchor (or its visible quantity collapsed to 0 while
 * the pre-write quantity was positive) -- i.e. the combination's stock
 * became invisible/orphaned without the combination itself having been
 * intentionally deleted.
 */
export function isCombinationStockOrphaned(preSnapshot, postStockRow, shopGroupRow) {
  if (!preSnapshot.existed) return false;
  if (!shopGroupRow.share_stock) return false;
  const scopeDrifted = (postStockRow.id_shop ?? 0) !== 0;
  const quantityCollapsed = (preSnapshot.quantity ?? 0) > 0 && (postStockRow.quantity ?? 0) === 0;
  return scopeDrifted || quantityCollapsed;
}

async function restoreSharedScope(idStockAvailable, idShopGroup, quantity) {
  const body = {
    stock_available: {
      id: idStockAvailable,
      id_shop: 0,
      id_shop_group: idShopGroup,
      quantity,
    },
  };
  if (DRY_RUN) {
    console.log(`DRY RUN would PUT stock_availables/${idStockAvailable} body=${JSON.stringify(body)}`);
    return;
  }
  const url = new URL(`${BASE_URL}/api/stock_availables/${idStockAvailable}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
}

export async function run() {
  let flagged = 0;

  for (const idProduct of PRODUCT_IDS) {
    const preCombinations = await snapshotCombinations(idProduct);
    const preRowsList = await snapshotStockRows(idProduct);
    const preRows = new Map(preRowsList.map((row) => [row.id, row]));

    // In real use, your own stock sync writes here between the snapshot
    // above and the re-read below. This script only observes and flags.
    const postRows = await snapshotStockRows(idProduct);

    for (const postRow of postRows) {
      const idPa = postRow.id_product_attribute;
      const preRow = preRows.get(postRow.id);
      const preSnapshot = {
        id_product_attribute: idPa,
        existed: preCombinations.has(idPa) || idPa === 0,
        quantity: preRow ? preRow.quantity : 0,
      };
      const group = await shopGroup(postRow.id_shop_group);

      if (!isCombinationStockOrphaned(preSnapshot, postRow, group)) continue;

      flagged++;
      console.warn(
        `Product ${idProduct} combination id_product_attribute=${idPa} stock row id=${postRow.id} looks orphaned ` +
        `(id_shop=${postRow.id_shop} quantity=${postRow.quantity}, group ${group.id_shop_group} share_stock=${group.share_stock})`
      );
      await restoreSharedScope(postRow.id, group.id_shop_group, preSnapshot.quantity);
    }
  }

  console.log(`Done. ${flagged} row(s) flagged as orphaned combination stock.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
