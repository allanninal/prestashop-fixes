/**
 * Find and repair PrestaShop products whose default combination pointer is stale.
 *
 * A product with combinations shows its headline price by resolving id_default_combination
 * to one specific combination row. When that pointer is 0, blank, or names a combination
 * that was deleted, deactivated, or belongs to a different product, the price lookup has
 * nothing valid to read and the product displays a price of zero even though its other
 * combinations have real prices.
 *
 * This script lists products, pulls each one's live combinations, and checks whether the
 * stored id_default_combination resolves to an active combination that still belongs to
 * that product. When it does not and an eligible combination exists, it repairs the
 * pointer to the cheapest eligible one. When no eligible combination exists at all, it
 * flags the product for a human instead of guessing. The only write is a PUT on the
 * product's own id_default_combination field; combination rows are never modified.
 *
 * Guide: https://www.allanninal.dev/prestashop/missing-default-combination-zero-price/
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
 * idProduct: the product being checked.
 * currentDefaultId: the product's stored id_default_combination value.
 * combinations: the product's live combinations, each an object with id, id_product,
 *   active, and price.
 *
 * Returns a decision object describing what to do. All HTTP calls happen in the caller.
 */
export function decideDefaultCombination(idProduct, currentDefaultId, combinations) {
  const eligible = (c) => String(c.id_product) === String(idProduct) && String(c.active ?? "0") === "1";

  const liveIds = new Set(combinations.filter(eligible).map((c) => String(c.id)));
  const isValid = !["", "0", "null", "undefined"].includes(String(currentDefaultId ?? "")) &&
    liveIds.has(String(currentDefaultId));

  if (isValid) {
    return {
      action: "none",
      reason: "default combination is active and belongs to the product",
      targetId: null,
    };
  }

  const eligibleCombos = combinations.filter(eligible);
  if (eligibleCombos.length === 0) {
    return {
      action: "flag",
      reason: "no active combination belongs to this product",
      targetId: null,
    };
  }

  const cheapest = eligibleCombos.reduce((best, c) =>
    Number(c.price || 0) < Number(best.price || 0) ? c : best
  );
  return {
    action: "repair",
    reason: "default combination missing or invalid, replacing with cheapest active one",
    targetId: cheapest.id,
  };
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function apiPut(path, resourceKey, body) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ [resourceKey]: body }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT ${path}`);
  return res.json();
}

async function listProductsWithCombinations(limit = 100) {
  const data = await apiGet("products", { display: "full", limit });
  const products = data.products || [];
  return products.filter((p) => String(p.id_default_combination ?? "0") !== "");
}

async function listCombinations(idProduct) {
  const data = await apiGet("combinations", {
    "filter[id_product]": idProduct,
    display: "full",
  });
  return data.combinations || [];
}

async function repairDefaultCombination(product, targetCombinationId) {
  const body = { ...product, id_default_combination: targetCombinationId };
  return apiPut(`products/${product.id}`, "product", body);
}

export async function run() {
  let flagged = 0;
  let repaired = 0;
  for (const product of await listProductsWithCombinations()) {
    const idProduct = product.id;
    const currentDefaultId = product.id_default_combination;

    const combinations = await listCombinations(idProduct);
    const decision = decideDefaultCombination(idProduct, currentDefaultId, combinations);

    if (decision.action === "none") continue;

    flagged++;
    console.warn(
      `Product ${idProduct} current id_default_combination=${currentDefaultId} ` +
        `action=${decision.action} reason=${decision.reason} target_id=${decision.targetId}`
    );

    if (decision.action === "repair" && !DRY_RUN) {
      await repairDefaultCombination(product, decision.targetId);
      repaired++;
      console.log(`Repaired product ${idProduct} id_default_combination=${decision.targetId}.`);
    }
  }
  console.log(`Done. ${flagged} product(s) flagged, ${repaired} repaired.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
