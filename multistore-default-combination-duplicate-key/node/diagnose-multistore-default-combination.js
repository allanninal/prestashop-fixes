/**
 * Diagnose duplicate or missing default combinations across PrestaShop shops.
 *
 * In multistore, the default combination flag is meant to be scoped per shop
 * through product_attribute_shop, but the unique index behind product_default
 * was not always shop aware in older 1.6 style code paths. Creating or
 * converting a default combination on a second shop can then collide with
 * the default already set on the first shop, and the failed write can leave
 * a shop with two combinations flagged default_on=1, or with none at all.
 *
 * This script reads every shop, then for each product in a given id range
 * pulls that product's combinations filtered to each id_shop and classifies
 * the state with a pure function. It only reports by default. Set
 * DRY_RUN=false to also apply a two step repair per flagged product and
 * shop: clear every extra default row in that shop first, one PUT per
 * id_product_attribute, then PUT the product's id_default_combination to
 * the surviving row.
 *
 * Guide: https://www.allanninal.dev/prestashop/multistore-default-combination-duplicate-key/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const ID_PRODUCT_START = Number(process.env.ID_PRODUCT_START || 1);
const ID_PRODUCT_END = Number(process.env.ID_PRODUCT_END || 1);

function authHeader() {
  return "Basic " + Buffer.from(`${WS_KEY}:`).toString("base64");
}

export function classifyDefaultCombinationState(combinations, idDefaultCombination, shopActive) {
  if (!combinations || combinations.length === 0) return "NOT_APPLICABLE";
  const defaultFlags = combinations.filter((c) => String(c.default_on) === "1");
  if (defaultFlags.length > 1) return "DUPLICATE_DEFAULT";
  if (defaultFlags.length === 0) return shopActive ? "MISSING_DEFAULT" : "NOT_APPLICABLE";
  const onlyDefault = defaultFlags[0];
  if (
    idDefaultCombination !== null &&
    idDefaultCombination !== undefined &&
    onlyDefault.id_product_attribute !== idDefaultCombination
  ) {
    return "POINTER_MISMATCH";
  }
  return "OK";
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

async function allShops() {
  const data = await apiGet("shops", { display: "full" });
  return data.shops || [];
}

async function combinationsForProductShop(idProduct, idShop) {
  const data = await apiGet("combinations", {
    "filter[id_product]": idProduct,
    id_shop: idShop,
    display: "full",
  });
  return data.combinations || [];
}

async function productDefaultCombination(idProduct) {
  const data = await apiGet(`products/${idProduct}`, { display: "full" });
  const raw = data.product?.id_default_combination;
  return raw && raw !== "0" ? Number(raw) : null;
}

async function scanProduct(idProduct, shops) {
  const findings = [];
  const idDefaultCombination = await productDefaultCombination(idProduct);
  for (const shop of shops) {
    const idShop = Number(shop.id);
    const shopActive = String(shop.active ?? "1") === "1";
    const combos = await combinationsForProductShop(idProduct, idShop);
    const state = classifyDefaultCombinationState(combos, idDefaultCombination, shopActive);
    if (state !== "OK" && state !== "NOT_APPLICABLE") {
      findings.push({ id_product: idProduct, id_shop: idShop, state, combinations: combos });
    }
  }
  return findings;
}

async function repairFinding(finding) {
  const { id_product: idProduct, id_shop: idShop, state, combinations: combos } = finding;
  let survivor;
  let extras = [];

  if (state === "DUPLICATE_DEFAULT") {
    const defaults = combos.filter((c) => String(c.default_on) === "1");
    survivor = defaults.reduce((a, b) => (Number(a.id_product_attribute) <= Number(b.id_product_attribute) ? a : b));
    extras = defaults.filter((c) => c !== survivor);
  } else if (state === "MISSING_DEFAULT") {
    survivor = combos.reduce((a, b) => (Number(a.id_product_attribute) <= Number(b.id_product_attribute) ? a : b));
  } else if (state === "POINTER_MISMATCH") {
    survivor = combos.filter((c) => String(c.default_on) === "1")[0];
  } else {
    return;
  }

  for (const extra of extras) {
    const paId = extra.id_product_attribute;
    console.log(
      `Product ${idProduct} shop ${idShop}: clearing default_on on id_product_attribute ${paId}. ${DRY_RUN ? "would write" : "writing"}`
    );
    if (!DRY_RUN) await apiPut(`combinations/${paId}`, { ...extra, default_on: 0 });
  }

  const paId = survivor.id_product_attribute;
  console.log(
    `Product ${idProduct} shop ${idShop}: setting id_default_combination to ${paId}. ${DRY_RUN ? "would write" : "writing"}`
  );
  if (!DRY_RUN) await apiPut(`products/${idProduct}`, { id_default_combination: paId });
}

export async function run() {
  const shops = await allShops();
  let totalFindings = 0;
  for (let idProduct = ID_PRODUCT_START; idProduct <= ID_PRODUCT_END; idProduct++) {
    const findings = await scanProduct(idProduct, shops);
    for (const finding of findings) {
      console.warn(`Product ${finding.id_product} shop ${finding.id_shop}: ${finding.state}`);
      await repairFinding(finding);
      totalFindings++;
    }
  }
  console.log(`Done. ${totalFindings} product/shop finding(s) ${DRY_RUN ? "to repair" : "repaired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
