/**
 * Find and, if confirmed, merge duplicate PrestaShop stock_available rows.
 *
 * ps_stock_available has a unique key (product_sqlstock) on id_product,
 * id_product_attribute, id_shop, and id_shop_group. StockAvailable::setQuantity()
 * selects a row for that key then decides to update or insert. Two near
 * simultaneous writes can both miss each other's row and both try to insert,
 * so the second one hits a duplicate entry error on product_sqlstock, or in
 * multistore installs lands as an orphan row scoped to id_shop=0/id_shop_group=0.
 *
 * This script enumerates stock_availables for a product, groups them by that
 * same natural key, and reports any group with more than one row. By default
 * it only reports. Set DRY_RUN=false to let it PUT the merged keep row and
 * DELETE the extra rows, after you confirm the quantities.
 *
 * Guide: https://www.allanninal.dev/prestashop/stock-available-duplicate-key-error/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function authHeader() {
  return "Basic " + Buffer.from(`${WS_KEY}:`).toString("base64");
}

function naturalKey(row) {
  return [
    Number(row.id_product),
    Number(row.id_product_attribute),
    Number(row.id_shop),
    Number(row.id_shop_group),
  ].join("|");
}

/**
 * Group stock_availables rows by (id_product, id_product_attribute, id_shop,
 * id_shop_group) and return only the groups with more than one row. Each
 * group is sorted so the row with id_shop !== 0 and the highest id sorts
 * first, the keep candidate for a merge. Pure: no network, no side effects.
 */
export function findDuplicateStockRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = naturalKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const duplicates = [];
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const ordered = [...group].sort((a, b) => {
      const aKeep = Number(a.id_shop) !== 0 ? 1 : 0;
      const bKeep = Number(b.id_shop) !== 0 ? 1 : 0;
      if (aKeep !== bKeep) return bKeep - aKeep;
      return Number(b.id) - Number(a.id);
    });
    duplicates.push(ordered);
  }
  return duplicates;
}

/**
 * Return stock rows whose id_product_attribute no longer exists among
 * liveIds (the current combination ids on the product). A row with
 * id_product_attribute === 0 is the simple-product row and is never orphaned.
 */
export function findOrphanedCombinationRows(rows, liveIds) {
  return rows.filter((row) => {
    const attrId = Number(row.id_product_attribute);
    return attrId !== 0 && !liveIds.has(attrId);
  });
}

async function apiGet(path, params = {}) {
  const qs = new URLSearchParams({ ...params, output_format: "JSON" });
  const res = await fetch(`${PRESTASHOP_URL}/api/${path}?${qs}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(`${PRESTASHOP_URL}/api/${path}?output_format=JSON`, {
    method: "PUT",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(`${PRESTASHOP_URL}/api/${path}`, {
    method: "DELETE",
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
}

async function stockRowsForProduct(idProduct) {
  const data = await apiGet("stock_availables", {
    "filter[id_product]": idProduct,
    display: "full",
  });
  return data.stock_availables || [];
}

async function liveCombinationIds(idProduct) {
  const data = await apiGet("combinations", {
    "filter[id_product]": idProduct,
    display: "full",
  });
  const rows = data.combinations || [];
  return new Set(rows.map((row) => Number(row.id)));
}

async function mergeDuplicateGroup(group) {
  const [keep, ...rest] = group;
  const quantities = group.map((row) => Number(row.quantity));
  const mergedQuantity = Math.max(...quantities);
  const body = { ...keep, quantity: mergedQuantity };
  console.warn(
    `Merging stock rows for product ${keep.id_product} attribute ${keep.id_product_attribute}: ` +
    `keep id=${keep.id} quantity ${keep.quantity} -> ${mergedQuantity}, dropping id(s) ${rest.map((r) => r.id)}`
  );
  if (!DRY_RUN) {
    await apiPut(`stock_availables/${keep.id}`, body);
    for (const row of rest) await apiDelete(`stock_availables/${row.id}`);
  }
  return { keepId: keep.id, mergedQuantity };
}

export async function run(idProduct) {
  const rows = await stockRowsForProduct(idProduct);
  const liveIds = await liveCombinationIds(idProduct);

  const duplicates = findDuplicateStockRows(rows);
  const orphans = findOrphanedCombinationRows(rows, liveIds);

  for (const group of duplicates) {
    console.warn(`Duplicate stock rows for key ${naturalKey(group[0])}: ${group.map((r) => r.id)}`);
    await mergeDuplicateGroup(group);
  }

  for (const row of orphans) {
    console.warn(`Orphaned stock row id=${row.id} references missing combination id_product_attribute=${row.id_product_attribute}`);
  }

  console.log(`Done. ${duplicates.length} duplicate group(s), ${orphans.length} orphaned row(s) for product ${idProduct}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targetProduct = process.env.TARGET_ID_PRODUCT;
  if (!targetProduct) {
    console.error("Set TARGET_ID_PRODUCT to the product id to check.");
    process.exit(1);
  }
  run(Number(targetProduct)).catch((err) => { console.error(err); process.exit(1); });
}
