/**
 * Find, and only on explicit confirmation rewrite, duplicate PrestaShop
 * product references or SKUs across different products.
 *
 * ps_product.reference has no unique, or even indexed-unique, database
 * constraint. The back office product form, the Duplicate product action, and
 * the Webservice API layer never check other rows before INSERT/UPDATE, so two
 * different id_product rows can carry the identical reference string
 * indefinitely. This is a known, unaddressed gap tracked on PrestaShop's own
 * bug tracker (GitHub #13413).
 *
 * This script pulls the catalog through the Webservice API, groups products
 * by a normalized (trimmed) reference, skips blank references since
 * PrestaShop allows and commonly has many, and reports every reference used
 * by more than one product id. By default it only reports. Set DRY_RUN=false
 * and supply RESOLUTION_MAP (a JSON object of {"id": "new reference"}) to let
 * it PUT a renamed reference for the ids you name. It never renames a
 * product you did not name, never merges, and never deletes.
 *
 * Guide: https://www.allanninal.dev/prestashop/duplicate-product-reference-sku/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const RESOLUTION_MAP = JSON.parse(process.env.RESOLUTION_MAP || "{}");

function authHeader() {
  return "Basic " + Buffer.from(`${WS_KEY}:`).toString("base64");
}

/**
 * products: list of {id, reference, name, active} as returned by
 * GET /api/products?display=[id,reference,name,active].
 *
 * Decision logic (no I/O):
 *   1. Normalize reference by trimming whitespace; skip entries whose
 *      normalized reference is "" (blank references are not collisions --
 *      PrestaShop allows and commonly has many blank references).
 *   2. Group remaining products by normalized reference.
 *   3. Keep only groups where group.length > 1 -- i.e. the same reference
 *      string is attached to 2+ distinct product ids.
 *   4. Return an object mapping reference -> array of the colliding product
 *      objects (id, name, active), sorted by id, for every collision found.
 *      Empty object means no collisions.
 *
 * This mirrors why the collision exists in PrestaShop: ps_product.reference
 * has no UNIQUE/DB constraint and the admin/back-office and duplicate-product
 * action never check other rows before INSERT/UPDATE, so two different
 * id_product rows can carry an identical reference string indefinitely.
 */
export function findReferenceCollisions(products) {
  const groups = new Map();
  for (const product of products) {
    const ref = (product.reference || "").trim();
    if (!ref) continue;
    if (!groups.has(ref)) groups.set(ref, []);
    groups.get(ref).push(product);
  }

  const collisions = {};
  for (const [ref, group] of groups) {
    if (group.length <= 1) continue;
    collisions[ref] = [...group].sort((a, b) => Number(a.id) - Number(b.id));
  }
  return collisions;
}

/**
 * Apply the same grouping/collision logic to combinations, since
 * combination-level references can collide across products too, and
 * PrestaShop does not enforce uniqueness there either. Pure: no I/O.
 */
export function findCombinationReferenceCollisions(combinations) {
  const normalized = combinations.map((c) => ({
    id: c.id,
    reference: c.reference,
    name: `product ${c.id_product}`,
    active: true,
  }));
  return findReferenceCollisions(normalized);
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

async function allProducts() {
  const data = await apiGet("products", {
    display: "[id,reference,name,active]",
    limit: "0",
  });
  return data.products || [];
}

async function allCombinations() {
  const data = await apiGet("combinations", {
    display: "[id,id_product,reference]",
  });
  return data.combinations || [];
}

async function applyResolution(idProduct, newReference) {
  const current = (await apiGet(`products/${idProduct}`)).product;
  current.reference = newReference;
  console.log(`Renaming product ${idProduct} reference to ${newReference}`);
  if (!DRY_RUN) {
    await apiPut(`products/${idProduct}`, { product: current });
  }
}

export async function run() {
  const products = await allProducts();
  const combinations = await allCombinations();

  const productCollisions = findReferenceCollisions(products);
  const comboCollisions = findCombinationReferenceCollisions(combinations);

  for (const [ref, group] of Object.entries(productCollisions)) {
    console.log(JSON.stringify({
      reference: ref,
      colliding_ids: group.map((p) => p.id),
      names: group.map((p) => p.name),
    }));
  }

  for (const [ref, group] of Object.entries(comboCollisions)) {
    console.log(JSON.stringify({
      combination_reference: ref,
      colliding_ids: group.map((c) => c.id),
      products: group.map((c) => c.name),
    }));
  }

  if (!DRY_RUN && Object.keys(RESOLUTION_MAP).length) {
    for (const [idProduct, newReference] of Object.entries(RESOLUTION_MAP)) {
      await applyResolution(idProduct, newReference);
    }
  }

  console.log(
    `Done. ${Object.keys(productCollisions).length} product reference collision(s), ` +
    `${Object.keys(comboCollisions).length} combination reference collision(s).`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
