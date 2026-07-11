/**
 * Flag PrestaShop categories written via the webservice without shop scoping.
 *
 * When a category is created or updated with a plain POST or PUT to /api/categories,
 * PrestaShop's ObjectModel::add()/update() associates it with every shop in the current
 * shop context unless the request explicitly narrows that with an id_shop query
 * parameter. The categories schema exposes id_shop_default, but that only marks the
 * shop used for display, it is not an association list (PrestaShop/PrestaShop issues
 * #13987 and #22918).
 *
 * This script lists the shops in the install, pulls back categories in a given window,
 * and runs a pure decision function that flags any category whose resolved shop ids go
 * beyond what was expected. It reports by default. A corrective PUT that resends the
 * same category body scoped to a single id_shop is only sent when DRY_RUN=false and
 * --confirm is passed, one category id at a time.
 *
 * Guide: https://www.allanninal.dev/prestashop/webservice-category-ignores-shop-scope/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const EXPECTED_SHOP_IDS = new Set(
  (process.env.EXPECTED_SHOP_IDS || "1").split(",").map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x))
);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Best-effort extraction of the shops a category is actually linked to.
 * Prefers an explicit associations.shops list when the install exposes one.
 * Falls back to id_shop_default, which is a display hint, not a true
 * association list, but is the only signal the standard schema guarantees.
 */
export function resolvedShopIds(category) {
  const associations = category.associations && category.associations.shops;
  if (associations && associations.length) {
    return new Set(associations.map((row) => Number(row.id)));
  }
  const fallback = category.id_shop_default;
  return fallback != null ? new Set([Number(fallback)]) : new Set();
}

/**
 * Pure decision function, no I/O.
 *
 * category: plain object with at least id_shop_default and, when available,
 *   associations.shops.
 * expectedShopIds: Set<number> of shop ids the integration intended to use.
 * allShopIds: Set<number> of every shop id in the install.
 *
 * Returns true when the category's resolved shop ids are a superset of the
 * expected set with extras, or when it is associated with every shop while
 * the expected set is narrower than that.
 */
export function isOverAssociated(category, expectedShopIds, allShopIds) {
  const associated = resolvedShopIds(category);
  if (associated.size === 0) return false;
  const overExpected = [...associated].some((id) => !expectedShopIds.has(id));
  const sameSize = associated.size === allShopIds.size;
  const coversAllShops = sameSize && [...allShopIds].every((id) => associated.has(id));
  const allShopsButExpectedNarrower = coversAllShops && expectedShopIds.size < allShopIds.size;
  return overExpected || allShopsButExpectedNarrower;
}

/** Companion function: the diff set for reporting. Pure, no I/O. */
export function unintendedShopIds(category, expectedShopIds) {
  const associated = resolvedShopIds(category);
  return new Set([...associated].filter((id) => !expectedShopIds.has(id)));
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function apiPut(path, resourceKey, body, params) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ [resourceKey]: body }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT ${path}`);
  return res.json();
}

async function allShopIds() {
  const data = await apiGet("shops", { display: "full" });
  const rows = data.shops || [];
  return new Set(rows.map((row) => Number(row.id)));
}

async function recentCategories(dateFrom) {
  const data = await apiGet("categories", {
    display: "full",
    "filter[date_add]": `[${dateFrom},today]`,
  });
  return data.categories || [];
}

async function rescopeCategoryToSingleShop(category, idShop) {
  // Resend the identical body, only scoping the query string to id_shop and
  // updating id_shop_default. This is the documented pattern; there is no
  // dedicated association endpoint for categories.
  const body = { ...category, id_shop_default: idShop };
  return apiPut(`categories/${category.id}`, "category", body, {
    output_format: "JSON",
    id_shop: idShop,
  });
}

export async function run(dateFrom = "2000-01-01", confirm = false) {
  const shops = await allShopIds();
  let flagged = 0;
  let repaired = 0;
  for (const category of await recentCategories(dateFrom)) {
    if (!isOverAssociated(category, EXPECTED_SHOP_IDS, shops)) continue;
    flagged++;
    const extra = [...unintendedShopIds(category, EXPECTED_SHOP_IDS)].sort((a, b) => a - b);
    console.warn(`Category id=${category.id} id_shop_default=${category.id_shop_default} unintended_shop_ids=${JSON.stringify(extra)}`);
    if (!DRY_RUN && confirm && EXPECTED_SHOP_IDS.size === 1) {
      const targetShop = [...EXPECTED_SHOP_IDS][0];
      await rescopeCategoryToSingleShop(category, targetShop);
      repaired++;
      console.log(`Rescoped category id=${category.id} to id_shop=${targetShop}.`);
    }
  }
  console.log(`Done. ${flagged} categorie(s) flagged, ${repaired} repaired.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const confirm = process.argv.includes("--confirm");
  run(undefined, confirm).catch((err) => { console.error(err); process.exit(1); });
}
