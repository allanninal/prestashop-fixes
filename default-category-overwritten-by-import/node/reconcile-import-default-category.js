/**
 * Catch and safely repair a PrestaShop product default category overwritten by import.
 *
 * PrestaShop's product CSV importer (AdminImportController) builds each row
 * independently from the Category column. When multiple category ids or names
 * are comma separated it has historically picked the first one in the list, or
 * in older "Force ID" flows silently reset id_category_default to whatever the
 * file's ordering implies, rather than preserving the product's prior default
 * (PrestaShop/PrestaShop issues #27938 and #10871). A partial update file that
 * omits the category column can cause the same overwrite (issue #32412). In
 * multistore, the default category is scoped per shop, so an import run
 * without shop scoping can overwrite the wrong shop's default.
 *
 * This script snapshots every affected product's id_category_default before an
 * import, re-reads the same products after, and runs a pure decision function
 * that classifies each product as unchanged, needing manual review (flag), or
 * a safe automatic repair candidate (the classic "reset to Home" signature). A
 * restoring PUT is only sent when DRY_RUN=false, scoped per shop, and only for
 * the repair action. Ambiguous changes and dropped associations are always
 * flagged, never auto-written.
 *
 * Guide: https://www.allanninal.dev/prestashop/default-category-overwritten-by-import/
 *
 * Run right before and right after a catalog import. Safe to run again and again.
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const ROOT_CATEGORY_ID = Number(process.env.ROOT_CATEGORY_ID || 2);

/**
 * Pure decision function, no I/O.
 *
 * productId: int, the product being checked.
 * idShop: number | null, the shop context, or null for a single-shop install.
 * preImportDefault: int, id_category_default read before the import.
 * postImportDefault: int, id_category_default read after the import.
 * postImportCategoryIds: number[], associations.categories.category[].id read
 *   after the import.
 * rootCategoryId: number, the store's root/Home category id, default 2.
 *
 * Returns { productId, idShop, action, reason, restoreTo }. action is one of
 * "none", "flag", "repair". restoreTo is preImportDefault when a repair or a
 * flagged-for-confirmation change is proposed, otherwise null.
 *
 * Logic:
 *   - postImportDefault === preImportDefault -> action="none".
 *   - preImportDefault not in postImportCategoryIds -> action="flag" (the
 *     default category link itself was lost, needs manual review; it is not
 *     safe to restore an association that is gone too).
 *   - postImportDefault === rootCategoryId and preImportDefault is not ->
 *     action="repair", restoreTo=preImportDefault (classic "reset to Home"
 *     corruption signature).
 *   - otherwise -> action="flag", restoreTo=preImportDefault (ambiguous
 *     change, surface for human confirmation rather than blind overwrite).
 */
export function decideCategoryRepair(productId, idShop, preImportDefault, postImportDefault,
                                      postImportCategoryIds, rootCategoryId = 2) {
  const postIds = (postImportCategoryIds || []).map(Number);
  const preDefault = Number(preImportDefault);
  const postDefault = Number(postImportDefault);
  const root = Number(rootCategoryId);

  if (postDefault === preDefault) {
    return { productId, idShop, action: "none", reason: "default unchanged", restoreTo: null };
  }
  if (!postIds.includes(preDefault)) {
    return {
      productId, idShop, action: "flag",
      reason: "prior default is no longer in associations, needs manual review",
      restoreTo: null,
    };
  }
  if (postDefault === root && preDefault !== root) {
    return {
      productId, idShop, action: "repair",
      reason: "reset to Home/root category, classic import corruption",
      restoreTo: preDefault,
    };
  }
  return {
    productId, idShop, action: "flag",
    reason: "ambiguous change, surface for human confirmation",
    restoreTo: preDefault,
  };
}

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
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

function categoryIdsOf(row) {
  const categories = row.associations?.categories?.category || [];
  return categories.map((c) => Number(c.id));
}

async function readProductState(productId, idShop) {
  const params = {
    "filter[id]": productId,
    display: "[id,id_category_default,associations.categories]",
  };
  if (idShop != null) params.id_shop = idShop;
  const data = await apiGet("products", params);
  const rows = data.products || [];
  if (!rows.length) return null;
  const row = rows[0];
  return {
    idCategoryDefault: Number(row.id_category_default),
    categoryIds: categoryIdsOf(row),
  };
}

/** Read id_category_default for every (productId, idShop) pair before an import. */
export async function snapshot(productIds, shopIds = [null]) {
  const result = new Map();
  for (const pid of productIds) {
    for (const sid of shopIds) {
      const state = await readProductState(pid, sid);
      if (state) result.set(`${pid}:${sid}`, state.idCategoryDefault);
    }
  }
  return result;
}

/**
 * Fetch-modify-PUT the product, resetting only id_category_default.
 *
 * Adds the category id back into associations.categories if it was dropped,
 * so the default is never left pointing outside the product's own
 * associations. Scoped to idShop when provided, so a multistore repair never
 * touches the "all shops" context.
 */
async function restoreDefaultCategory(productId, idShop, restoreTo) {
  const params = idShop != null ? { id_shop: idShop } : {};
  const current = (await apiGet(`products/${productId}`, params)).product;
  const body = { ...current, id_category_default: restoreTo };
  const categories = body.associations?.categories?.category || [];
  const ids = new Set(categories.map((c) => Number(c.id)));
  if (!ids.has(restoreTo)) {
    categories.push({ id: restoreTo });
    body.associations = { ...(body.associations || {}), categories: { category: categories } };
  }
  return apiPut(`products/${productId}`, "product", body, params);
}

/** Compare the pre-import snapshot to the current state and act per decision. */
export async function reconcile(preSnapshot, productIds, shopIds = [null]) {
  let flagged = 0;
  let repaired = 0;
  for (const pid of productIds) {
    for (const sid of shopIds) {
      const key = `${pid}:${sid}`;
      const preDefault = preSnapshot.get(key);
      if (preDefault == null) {
        console.log(`Skipping product ${pid} (shop ${sid}): no pre-import snapshot.`);
        continue;
      }
      const postState = await readProductState(pid, sid);
      if (!postState) {
        console.warn(`Skipping product ${pid} (shop ${sid}): not found after import.`);
        continue;
      }
      const decision = decideCategoryRepair(
        pid, sid, preDefault, postState.idCategoryDefault, postState.categoryIds, ROOT_CATEGORY_ID,
      );
      if (decision.action === "none") continue;
      if (decision.action === "flag") {
        flagged++;
        console.warn(`FLAG product=${pid} shop=${sid}: ${decision.reason} (pre=${preDefault} post=${postState.idCategoryDefault})`);
        continue;
      }
      console.warn(`REPAIR candidate product=${pid} shop=${sid}: ${decision.reason} (pre=${preDefault} post=${postState.idCategoryDefault})`);
      if (!DRY_RUN) {
        await restoreDefaultCategory(pid, sid, decision.restoreTo);
        repaired++;
        console.log(`Repaired product=${pid} shop=${sid}: restored id_category_default=${decision.restoreTo}.`);
      }
    }
  }
  console.log(`Done. ${flagged} flagged for review, ${repaired} repaired.`);
}

/**
 * Take and return the pre-import snapshot. Persist it yourself, run your
 * import, then call reconcile(savedSnapshot, productIds, shopIds) after.
 */
export async function run(productIds, shopIds = [null]) {
  const preSnapshot = await snapshot(productIds, shopIds);
  console.log(`Snapshotted ${preSnapshot.size} product/shop pair(s) before import.`);
  return preSnapshot;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ids = (process.env.PRODUCT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (!ids.length) {
    console.log("Set PRODUCT_IDS to a comma separated list of product ids to check.");
  } else {
    run(ids)
      .then((snap) => reconcile(snap, ids))
      .catch((err) => { console.error(err); process.exit(1); });
  }
}
