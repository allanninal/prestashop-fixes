/**
 * Swap a PrestaShop product's default combination without hitting product_default.
 *
 * ps_product_attribute has a unique key (product_default) that allows only one
 * row per id_product to hold default_on=1. The back office clears default_on on
 * the old default and sets it on the new one in a single save. The Webservice
 * API does not do that clearing step for you, so PUTting default_on=1 on a new
 * combination while another one still holds it collides with the unique key
 * and PrestaShop returns a duplicate entry error for product_default.
 *
 * This script reads the combinations for a product, finds whichever one
 * currently holds default_on=1, and if it is not already the target, clears it
 * first with one PUT, then sets default_on=1 on the target with a second PUT.
 * If the target is already the default it does nothing. Set DRY_RUN=false to
 * let it write for real.
 *
 * Guide: https://www.allanninal.dev/prestashop/webservice-default-combination-duplicate-key/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function authHeader() {
  return "Basic " + Buffer.from(`${WS_KEY}:`).toString("base64");
}

export function currentDefaultId(rows) {
  const row = rows.find((r) => Number(r.default_on || 0) === 1);
  return row ? Number(row.id) : null;
}

/**
 * Pure decision: given the id currently flagged default and the id we want
 * to become default, return the ordered list of writes to make.
 *
 * Returns an empty array when the target is already the default. Otherwise
 * returns at most two steps, always in this order: clear the old default
 * first, then set the new one. That order is what avoids ever having two
 * rows claim default_on=1 at the same time.
 */
export function planDefaultSwap(currentDefaultId, targetId) {
  if (currentDefaultId === targetId) return [];
  const steps = [];
  if (currentDefaultId !== null && currentDefaultId !== undefined) {
    steps.push({ id: currentDefaultId, default_on: 0 });
  }
  steps.push({ id: targetId, default_on: 1 });
  return steps;
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

async function combinationsForProduct(idProduct) {
  const data = await apiGet("combinations", {
    "filter[id_product]": idProduct,
    display: "full",
  });
  return data.combinations || [];
}

async function setDefaultOn(row, defaultOn) {
  const body = { ...row, default_on: defaultOn };
  return apiPut(`combinations/${row.id}`, body);
}

export async function run(idProduct, targetId) {
  const rows = await combinationsForProduct(idProduct);
  const byId = new Map(rows.map((row) => [Number(row.id), row]));

  if (!byId.has(targetId)) {
    throw new Error(`Combination ${targetId} was not found on product ${idProduct}.`);
  }

  const oldDefaultId = currentDefaultId(rows);
  const steps = planDefaultSwap(oldDefaultId, targetId);

  if (steps.length === 0) {
    console.log(`Combination ${targetId} is already the default for product ${idProduct}. Nothing to do.`);
    return;
  }

  for (const step of steps) {
    const row = byId.get(step.id);
    console.log(`Setting combination ${step.id} default_on=${step.default_on}. ${DRY_RUN ? "would write" : "writing"}`);
    if (!DRY_RUN) await setDefaultOn(row, step.default_on);
  }

  console.log(`${DRY_RUN ? "Would swap" : "Swapped"} default combination for product ${idProduct} from ${oldDefaultId} to ${targetId}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targetProduct = process.env.TARGET_ID_PRODUCT;
  const targetCombination = process.env.TARGET_ID_COMBINATION;
  if (!targetProduct || !targetCombination) {
    console.error("Set TARGET_ID_PRODUCT and TARGET_ID_COMBINATION to run this.");
    process.exit(1);
  }
  run(Number(targetProduct), Number(targetCombination)).catch((err) => { console.error(err); process.exit(1); });
}
