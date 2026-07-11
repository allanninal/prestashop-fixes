/**
 * Detect and repair PrestaShop products whose visibility silently reverts.
 *
 * visibility ("both"/"catalog"/"search"/"none") lives per shop in ps_product_shop,
 * keyed by id_shop, not as a single attribute on the product. Scheduled sync jobs
 * (ERP feeds, price/stock updaters, marketplace connectors) typically PUT the full
 * product resource on every run from a source of truth that never tracked a
 * merchant's manual visibility override, so each sync silently writes visibility
 * back to "both" (PrestaShop/PrestaShop GitHub issue #14386). Multistore installs
 * also carry a long standing webservice bug where PUT does not reliably honor
 * id_shop scoping, so a change meant for one shop can land on, or be read back
 * from, the default shop instead (issues #15317 and #35901).
 *
 * This script keeps an intended-state map of "productId:idShop" -> visibility,
 * reads the real value scoped by id_shop, and reapplies a drifted value exactly
 * once with a scoped PUT. If the same pair reverts again after that one reapply,
 * it stops writing and flags the pair for a human instead of looping against a
 * job it cannot see.
 *
 * Guide: https://www.allanninal.dev/prestashop/product-visibility-reverts/
 *
 * Run on a schedule. Safe to run again and again.
 */
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const REPAIRED_ONCE_STATE_FILE = process.env.REPAIRED_ONCE_STATE_FILE || "repaired_once.json";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * intended: plain object keyed by "productId:idShop" -> visibility the merchant wants.
 * actual: same shape, the value read back from PrestaShop.
 * alreadyRepairedOnce: Set of "productId:idShop" keys already reapplied once in a
 *   previous run, used as the repair-loop cutoff.
 *
 * For each key in intended, compares actual[key] to intended[key]:
 *   - equal                                     -> action "none"
 *   - different and key not in alreadyRepairedOnce -> action "reapply"
 *   - different and key IS in alreadyRepairedOnce   -> action "flag"
 *     (a prior reapply already reverted again, do not auto-repair a second time)
 *
 * Returns a list of {productId, idShop, intended, actual, action} decision
 * records, one per key in intended. No network or DB calls.
 */
export function decideVisibilityAction(intended, actual, alreadyRepairedOnce) {
  const decisions = [];
  for (const [key, intendedValue] of Object.entries(intended)) {
    const [productIdStr, idShopStr] = key.split(":");
    const actualValue = actual[key];

    let action;
    if (actualValue === intendedValue) {
      action = "none";
    } else if (!alreadyRepairedOnce.has(key)) {
      action = "reapply";
    } else {
      action = "flag";
    }

    decisions.push({
      productId: Number(productIdStr),
      idShop: Number(idShopStr),
      intended: intendedValue,
      actual: actualValue === undefined ? null : actualValue,
      action,
    });
  }
  return decisions;
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

async function listShops() {
  const data = await apiGet("shops", { display: "full" });
  return data.shops || [];
}

async function actualVisibility(idProduct, idShop) {
  const data = await apiGet(`products/${idProduct}`, {
    display: "[id,visibility,active,id_shop_default]",
    id_shop: idShop,
  });
  return (data.product || {}).visibility;
}

async function findDriftedToBoth(productIds) {
  const idList = `[${productIds.join(",")}]`;
  const data = await apiGet("products", {
    "filter[visibility]": "both",
    "filter[id]": idList,
    display: "[id,visibility]",
  });
  return data.products || [];
}

async function reapplyVisibility(idProduct, idShop, visibility) {
  const body = { id: idProduct, visibility };
  return apiPut(`products/${idProduct}`, "product", body, { id_shop: idShop });
}

function loadRepairedOnce() {
  if (!existsSync(REPAIRED_ONCE_STATE_FILE)) return new Set();
  const pairs = JSON.parse(readFileSync(REPAIRED_ONCE_STATE_FILE, "utf8"));
  return new Set(pairs);
}

function saveRepairedOnce(pairs) {
  writeFileSync(REPAIRED_ONCE_STATE_FILE, JSON.stringify([...pairs].sort()));
}

export async function run(intended) {
  const alreadyRepairedOnce = loadRepairedOnce();

  const actual = {};
  for (const key of Object.keys(intended)) {
    const [productIdStr, idShopStr] = key.split(":");
    actual[key] = await actualVisibility(Number(productIdStr), Number(idShopStr));
  }

  const decisions = decideVisibilityAction(intended, actual, alreadyRepairedOnce);

  let reapplied = 0;
  let flagged = 0;
  const newlyRepaired = new Set(alreadyRepairedOnce);

  for (const d of decisions) {
    const key = `${d.productId}:${d.idShop}`;
    if (d.action === "none") continue;
    if (d.action === "reapply") {
      console.warn(
        `Product ${d.productId} shop ${d.idShop} drifted: intended=${d.intended} actual=${d.actual}. ` +
          `${DRY_RUN ? "would reapply" : "reapplying"}`
      );
      if (!DRY_RUN) {
        await reapplyVisibility(d.productId, d.idShop, d.intended);
        newlyRepaired.add(key);
      }
      reapplied++;
    } else if (d.action === "flag") {
      console.error(
        `Product ${d.productId} shop ${d.idShop} reverted again after a repair: intended=${d.intended} actual=${d.actual}. ` +
          `Not auto-repairing again, a competing job is likely overwriting this.`
      );
      flagged++;
    }
  }

  if (!DRY_RUN) saveRepairedOnce(newlyRepaired);

  console.log(`Done. ${reapplied} pair(s) reapplied, ${flagged} pair(s) flagged for a human.`);
  return decisions;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Example intended-state map. Replace with your real source, e.g. a JSON
  // file or a database table of products you deliberately hid per shop.
  const exampleIntended = {
    "12:1": "none",
    "12:2": "both",
  };
  run(exampleIntended).catch((err) => { console.error(err); process.exit(1); });
}
