/**
 * Diagnose catalog listing price mismatches across PrestaShop shops.
 *
 * In multistore, per shop overrides for price and discounts live in
 * ps_product_shop and ps_specific_price, keyed by id_shop or id_shop_group,
 * while the base ps_product row holds only a default fallback value.
 * Several core controllers and list queries, notably the backoffice
 * Catalog product list (GitHub #12853), join or read from ps_product
 * instead of the shop scoped ps_product_shop, and Product::getFinalPrice()
 * / specific price resolution can also fail to filter strictly by the
 * loaded shop context (GitHub #20780), so a listing can surface one shop's
 * price or discount while the single product page, which does resolve
 * context correctly via id_shop, shows a different shop's real price for
 * the same id_product.
 *
 * This script reads every shop, then for each product in a given id range
 * pulls the listing context price and the single product context price
 * for that id_shop and compares them with a pure decision function. It
 * only reports by default. This is a core price resolution bug, not a
 * simple data write problem, so auto-fixing via the webservice is unsafe
 * in general; the correct remediation is applying or upgrading to the
 * PrestaShop core fix for the relevant tracker issue. Set DRY_RUN=false
 * only after confirming the discrepancy is a stray specific_price row
 * scoped to the wrong shop, in which case the script sends one scoped PUT
 * per id_product and id_shop carrying the correct price, then re-verifies
 * both prices.
 *
 * Guide: https://www.allanninal.dev/prestashop/multistore-listing-price-mismatch/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const PRICE_TOLERANCE = Number(process.env.PRICE_TOLERANCE || 0.01);
const ID_PRODUCT_START = Number(process.env.ID_PRODUCT_START || 1);
const ID_PRODUCT_END = Number(process.env.ID_PRODUCT_END || 1);

function authHeader() {
  return "Basic " + Buffer.from(`${WS_KEY}:`).toString("base64");
}

export function decidePriceMismatch(listingPrice, singleProductPrice, idProduct, idShop, tolerance = 0.01) {
  const diff = Math.abs(listingPrice - singleProductPrice);
  return {
    id_product: idProduct,
    id_shop: idShop,
    mismatch: diff > tolerance,
    diff,
    listing_price: listingPrice,
    single_product_price: singleProductPrice,
  };
}

async function apiGet(path, params = {}) {
  const qs = new URLSearchParams({ ...params, output_format: "JSON" });
  const res = await fetch(`${PRESTASHOP_URL}/api/${path}?${qs}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function apiPut(path, body, params = {}) {
  const qs = new URLSearchParams({ ...params, output_format: "JSON" });
  const res = await fetch(`${PRESTASHOP_URL}/api/${path}?${qs}`, {
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

async function listingPrice(idProduct, idShop) {
  const data = await apiGet("products", {
    id_shop: idShop,
    "filter[id]": idProduct,
    "filter[active]": 1,
    display: "full",
  });
  const rows = data.products || [];
  return rows.length ? Number(rows[0].price) : null;
}

async function singleProductPrice(idProduct, idShop) {
  const data = await apiGet(`products/${idProduct}`, { id_shop: idShop, display: "full" });
  const product = data.product || {};
  return "price" in product ? Number(product.price) : null;
}

async function scanProduct(idProduct, shops, tolerance) {
  const findings = [];
  for (const shop of shops) {
    const idShop = Number(shop.id);
    const listing = await listingPrice(idProduct, idShop);
    const single = await singleProductPrice(idProduct, idShop);
    if (listing === null || single === null) continue;
    const result = decidePriceMismatch(listing, single, idProduct, idShop, tolerance);
    if (result.mismatch) findings.push(result);
  }
  return findings;
}

async function repairFinding(finding) {
  const { id_product: idProduct, id_shop: idShop, single_product_price: correctPrice } = finding;

  console.log(`Product ${idProduct} shop ${idShop}: writing scoped price ${correctPrice}. ${DRY_RUN ? "would write" : "writing"}`);
  if (DRY_RUN) return;

  await apiPut(`products/${idProduct}`, { price: String(correctPrice) }, { id_shop: idShop });

  const newListing = await listingPrice(idProduct, idShop);
  const newSingle = await singleProductPrice(idProduct, idShop);
  const recheck = decidePriceMismatch(newListing, newSingle, idProduct, idShop, PRICE_TOLERANCE);
  if (recheck.mismatch) {
    console.warn(`Product ${idProduct} shop ${idShop}: still mismatched after write (diff ${recheck.diff}).`);
  } else {
    console.log(`Product ${idProduct} shop ${idShop}: verified in agreement after write.`);
  }
}

export async function run() {
  const shops = await allShops();
  let totalFindings = 0;
  for (let idProduct = ID_PRODUCT_START; idProduct <= ID_PRODUCT_END; idProduct++) {
    const findings = await scanProduct(idProduct, shops, PRICE_TOLERANCE);
    for (const finding of findings) {
      console.warn(`Product ${finding.id_product} shop ${finding.id_shop}: listing=${finding.listing_price} single=${finding.single_product_price} diff=${finding.diff}`);
      await repairFinding(finding);
      totalFindings++;
    }
  }
  console.log(`Done. ${totalFindings} product/shop mismatch(es) ${DRY_RUN ? "to repair" : "handled"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
