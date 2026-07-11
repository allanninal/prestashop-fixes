/**
 * Find PrestaShop categories and products orphaned outside the root tree.
 *
 * PrestaShop stores categories as a nested set tree (id_parent plus internal
 * nleft/nright bounds) rooted at each shop's designated root category
 * (shops.id_category, typically Home under a hidden super-root). If the root is
 * deleted directly instead of through the shop's reassignment flow, or a
 * category or product import sets id_parent to a non-existent or wrong-shop id,
 * child categories keep an id_parent that no longer resolves back to the root.
 * The front office only renders nodes reachable from the root, so the row stays
 * active in ps_category, and products stay linked via ps_category_product, but
 * neither is visible anywhere.
 *
 * This script reads each shop's true root id, pulls every category and active
 * product over the webservice, walks id_parent links with a breadth first
 * search from the root, and runs a pure decision function that flags any
 * category or product the walk never reaches. It reports by default. A
 * corrective PUT that re-parents an orphaned category root to the shop's Home
 * category is only sent when DRY_RUN=false and the target has been confirmed.
 *
 * Guide: https://www.allanninal.dev/prestashop/orphaned-categories-outside-root-tree/
 *
 * Run on a schedule, or right after a suspicious import. Safe to run again and again.
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * categories: array of plain objects, each with id, id_parent, is_root_category.
 * rootIds: Set<number> or array of valid shop root category ids (shops.id_category).
 * products: array of plain objects, each with id, id_category_default, category_ids (array<number>).
 *
 * Builds a parent to children adjacency map, walks it with a breadth first
 * search from rootIds to compute the reachable category ids, then returns the
 * category ids and product ids that walk never reaches.
 *
 * Returns { orphaned_categories: number[], orphaned_products: number[] }.
 */
export function findOrphans(categories, rootIds, products) {
  const rootSet = rootIds instanceof Set ? rootIds : new Set(rootIds);
  const children = new Map();
  for (const cat of categories) {
    const parent = cat.id_parent;
    if (parent !== null && parent !== undefined) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(cat.id);
    }
  }

  const reachable = new Set(rootSet);
  const queue = [...rootSet];
  while (queue.length) {
    const current = queue.shift();
    for (const childId of children.get(current) || []) {
      if (!reachable.has(childId)) {
        reachable.add(childId);
        queue.push(childId);
      }
    }
  }

  const orphanedCategories = categories
    .filter((cat) => !reachable.has(cat.id) && !rootSet.has(cat.id))
    .map((cat) => cat.id);

  const orphanedProducts = products
    .filter((p) => {
      const defaultReachable = reachable.has(p.id_category_default);
      const anyReachable = (p.category_ids || []).some((cid) => reachable.has(cid));
      return !defaultReachable && !anyReachable;
    })
    .map((p) => p.id);

  return { orphaned_categories: orphanedCategories, orphaned_products: orphanedProducts };
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function apiPut(path, resourceKey, body, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ [resourceKey]: body }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT ${path}`);
  return res.json();
}

async function shopRootIds() {
  const data = await apiGet("shops", { display: "full" });
  const rows = data.shops || [];
  const roots = new Set(rows.filter((r) => r.id_category).map((r) => Number(r.id_category)));
  if (roots.size) return roots;
  const cfg = await apiGet("configurations", { "filter[name]": "PS_HOME_CATEGORY" });
  const cfgRows = cfg.configurations || [];
  return new Set(cfgRows.filter((r) => r.value).map((r) => Number(r.value)));
}

async function allCategories() {
  const data = await apiGet("categories", { display: "full", limit: "0" });
  const rows = data.categories || [];
  return rows.map((row) => ({
    id: Number(row.id),
    id_parent: row.id_parent !== undefined && row.id_parent !== null && row.id_parent !== "" ? Number(row.id_parent) : null,
    is_root_category: ["1", "true", true].includes(row.is_root_category),
  }));
}

async function allActiveProducts() {
  const data = await apiGet("products", { display: "full", "filter[active]": "1", limit: "0" });
  const rows = data.products || [];
  return rows.map((row) => {
    const cats = (row.associations && row.associations.categories && row.associations.categories.category) || [];
    const categoryIds = cats.filter((c) => c.id).map((c) => Number(c.id));
    const hasDefault = row.id_category_default !== undefined && row.id_category_default !== null && row.id_category_default !== "";
    return {
      id: Number(row.id),
      id_category_default: hasDefault ? Number(row.id_category_default) : null,
      category_ids: categoryIds,
    };
  });
}

async function reparentCategoryToHome(category, homeCategoryId) {
  // Only used when DRY_RUN=false and a safe target has been confirmed.
  // PrestaShop recomputes nleft/nright for the moved subtree on save.
  const body = { ...category, id_parent: homeCategoryId };
  return apiPut(`categories/${category.id}`, "category", body);
}

export async function run() {
  const rootIds = await shopRootIds();
  const categories = await allCategories();
  const products = await allActiveProducts();
  const result = findOrphans(categories, rootIds, products);

  const { orphaned_categories: orphanedCategories, orphaned_products: orphanedProducts } = result;
  const byId = new Map(categories.map((cat) => [cat.id, cat]));

  for (const catId of orphanedCategories) {
    const cat = byId.get(catId) || {};
    console.warn(`Orphaned category id=${catId} id_parent=${cat.id_parent}`);
  }

  for (const prodId of orphanedProducts) {
    console.warn(`Orphaned product id=${prodId}`);
  }

  if (!DRY_RUN && orphanedCategories.length && rootIds.size) {
    const homeId = [...rootIds][0];
    for (const catId of orphanedCategories) {
      await reparentCategoryToHome(byId.get(catId), homeId);
      console.log(`Re-parented category id=${catId} to Home id_parent=${homeId}.`);
    }
  }

  console.log(
    `Done. ${orphanedCategories.length} orphaned categorie(s), ${orphanedProducts.length} orphaned product(s) ${DRY_RUN ? "reported" : "reported and categories repaired"}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
