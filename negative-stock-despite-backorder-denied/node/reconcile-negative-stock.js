/**
 * Find PrestaShop stock_available rows that are negative despite a deny backorder policy.
 *
 * PrestaShop stores a sellable quantity per (id_product, id_product_attribute, id_shop or
 * id_shop_group) row in stock_available. The front office and order validation code path
 * only checks the per-product out_of_stock flag (0 deny, 1 allow, 2 use the global
 * PS_ORDER_OUT_OF_STOCK setting) when a cart turns into an order. It never re-locks or
 * re-verifies the row at final payment and validation, so two near-simultaneous orders, or
 * an order racing a manual back-office edit or an import, can each decrement the same row
 * past zero even with a deny policy. In multistore with Share available quantities on, the
 * row is scoped to id_shop_group, so any shop in the group can decrement it, and combination
 * or pack rows that were never correctly scoped can drift negative outside checkout entirely.
 *
 * This is unsafe to auto-correct blindly, so the default behavior is to flag and report
 * every genuine violation. Only when explicitly run with DRY_RUN=false and --clamp does it
 * write quantity back as max(existing_quantity, 0), preserving id_product,
 * id_product_attribute, the shop scoping, depends_on_stock, and out_of_stock unchanged.
 *
 * Guide: https://www.allanninal.dev/prestashop/negative-stock-despite-backorder-denied/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const AUTH_HEADER = "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");

export function classifyStockViolation(quantity, outOfStock, globalDefaultDeny) {
  let policy;
  if (outOfStock === 0) {
    policy = "deny";
  } else if (outOfStock === 1) {
    policy = "allow";
  } else {
    // outOfStock === 2, inherit the store wide default
    policy = globalDefaultDeny ? "deny" : "allow";
  }

  const isViolation = policy === "deny" && quantity < 0;
  const clampTo = isViolation ? Math.max(quantity, 0) : null;
  return { policy, isViolation, clampTo };
}

async function apiGet(path, params = {}) {
  const query = new URLSearchParams({ ...params, output_format: "JSON" });
  const res = await fetch(`${PRESTASHOP_URL}/api/${path}?${query}`, {
    headers: { Authorization: AUTH_HEADER },
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function apiPut(path, resourceKey, body) {
  const res = await fetch(`${PRESTASHOP_URL}/api/${path}?output_format=JSON`, {
    method: "PUT",
    headers: { Authorization: AUTH_HEADER, "Content-Type": "application/json" },
    body: JSON.stringify({ [resourceKey]: body }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function allShops() {
  const data = await apiGet("shops", { display: "full" });
  return data.shops || [];
}

async function negativeStockRows() {
  const data = await apiGet("stock_availables", {
    display: "full",
    "filter[quantity]": "[-9999999,-1]",
  });
  return data.stock_availables || [];
}

async function globalDefaultDeny() {
  const data = await apiGet("configurations", { "filter[name]": "PS_ORDER_OUT_OF_STOCK", display: "full" });
  const configs = data.configurations || [];
  if (configs.length === 0) return true; // PrestaShop ships with deny as the safe default
  return String(configs[0].value ?? "0") === "0";
}

async function productOutOfStock(idProduct, cache) {
  if (cache.has(idProduct)) return cache.get(idProduct);
  const data = await apiGet(`products/${idProduct}`, { display: "full" });
  const value = Number(data.product?.out_of_stock ?? 2);
  cache.set(idProduct, value);
  return value;
}

async function combinationExists(idProductAttribute) {
  if (!idProductAttribute || Number(idProductAttribute) === 0) return true;
  const data = await apiGet(`combinations/${idProductAttribute}`);
  return Boolean(data.combination);
}

async function clampRow(row) {
  const body = {
    id: row.id,
    id_product: row.id_product,
    id_product_attribute: row.id_product_attribute ?? "0",
    id_shop: row.id_shop ?? "0",
    id_shop_group: row.id_shop_group ?? "0",
    quantity: Math.max(Number(row.quantity), 0),
    depends_on_stock: row.depends_on_stock ?? "0",
    out_of_stock: row.out_of_stock ?? "2",
  };
  return apiPut(`stock_availables/${row.id}`, "stock_available", body);
}

export async function run(clamp = false) {
  const shops = await allShops();
  console.log(`Scanning ${shops.length} shop(s) for negative stock_available rows.`);

  const defaultDeny = await globalDefaultDeny();
  const productCache = new Map();
  const flagged = [];

  for (const row of await negativeStockRows()) {
    const idProduct = row.id_product;
    const idProductAttribute = row.id_product_attribute;
    const quantity = Number(row.quantity);
    const outOfStock = await productOutOfStock(idProduct, productCache);

    const result = classifyStockViolation(quantity, outOfStock, defaultDeny);
    if (!result.isViolation) continue;

    const hasCombination = await combinationExists(idProductAttribute);
    flagged.push({
      id_shop: row.id_shop,
      id_shop_group: row.id_shop_group,
      id_product: idProduct,
      id_product_attribute: idProductAttribute,
      quantity,
      resolved_out_of_stock_policy: result.policy,
      orphaned_combination: idProductAttribute && Number(idProductAttribute) !== 0 && !hasCombination,
    });
    console.warn(
      `Violation: shop=${row.id_shop} product=${idProduct} attribute=${idProductAttribute} quantity=${quantity} policy=${result.policy}`
    );

    if (clamp && !DRY_RUN) {
      await clampRow(row);
      console.log(`Clamped stock_availables/${row.id} quantity to ${result.clampTo}.`);
    }
  }

  console.log(
    `Done. ${flagged.length} violation(s) found. ${clamp && !DRY_RUN ? "Clamped to zero." : "Reported only, no writes made."}`
  );
  return flagged;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const clampFlag = process.argv.includes("--clamp");
  run(clampFlag).catch((err) => { console.error(err); process.exit(1); });
}
