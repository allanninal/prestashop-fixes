/**
 * Detect PrestaShop stock rows where physical, reserved, and virtual quantity disagree.
 *
 * PrestaShop's StockAvailable model stores three numbers per product or combination that
 * should always reconcile: physical_quantity (units on the shelf), reserved_quantity (units
 * allocated to unshipped or unpaid orders), and quantity (the virtual sellable quantity,
 * physical minus reserved). The core only maintains that invariant through specific code
 * paths keyed off order_states flags, and documented core bugs plus direct writes from
 * modules, CSV import, or the webservice let the three fields drift apart.
 *
 * This script recomputes the expected reserved quantity by walking open orders for each
 * product, compares it against the stored stock_availables row, and flags any mismatch.
 * Because physical_quantity and reserved_quantity are core-managed and read-only by
 * convention, the only sanctioned write (when DRY_RUN=false) is to stock_availables.quantity,
 * set to physical_quantity minus the recomputed reserved quantity. reserved_quantity and
 * physical_quantity are never written; a human is notified to re-trigger the correct
 * order_histories transition or run a back-office stock regularization.
 *
 * Guide: https://www.allanninal.dev/prestashop/stock-quantity-formula-drift/
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
 * stockRow: { quantity, physicalQuantity, reservedQuantity }
 * computedReservedQuantity: recomputed by walking open orders
 * Returns { inSync, formulaViolation, reservedMismatch, expectedQuantity }.
 */
export function checkStockInvariant(stockRow, computedReservedQuantity) {
  const formulaViolation = stockRow.physicalQuantity !== stockRow.quantity + stockRow.reservedQuantity;
  const reservedMismatch = stockRow.reservedQuantity !== computedReservedQuantity;
  const expectedQuantity = stockRow.physicalQuantity - computedReservedQuantity;
  const inSync = !formulaViolation && !reservedMismatch;
  return { inSync, formulaViolation, reservedMismatch, expectedQuantity };
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

async function orderStateIsReserving(idState, stateCache) {
  if (stateCache.has(idState)) return stateCache.get(idState);
  const data = await apiGet(`order_states/${idState}`);
  const state = data.order_state || {};
  const paid = String(state.paid) === "1";
  const shipped = String(state.shipped) === "1";
  const reserving = !(paid && shipped);
  stateCache.set(idState, reserving);
  return reserving;
}

async function currentStateForOrder(idOrder) {
  const data = await apiGet("order_histories", {
    "filter[id_order]": idOrder,
    display: "full",
    sort: "date_add_DESC",
    limit: "1",
  });
  const histories = data.order_histories || [];
  if (!histories.length) return null;
  return histories[0].id_order_state;
}

async function computeReservedQuantity(idProduct, idProductAttribute, stateCache) {
  const data = await apiGet("order_details", {
    "filter[product_id]": idProduct,
    display: "full",
  });
  const details = data.order_details || [];
  let reserved = 0;
  for (const line of details) {
    if (idProductAttribute != null && String(line.product_attribute_id) !== String(idProductAttribute)) continue;
    const idState = await currentStateForOrder(line.id_order);
    if (idState == null) continue;
    if (await orderStateIsReserving(idState, stateCache)) {
      reserved += Number(line.product_quantity || 0);
    }
  }
  return reserved;
}

async function stockAvailableRows(idProduct) {
  const data = await apiGet("stock_availables", {
    "filter[id_product]": idProduct,
    display: "full",
  });
  return data.stock_availables || [];
}

async function repairQuantity(rawRow, expectedQuantity) {
  const body = {
    id: rawRow.id,
    id_product: rawRow.id_product,
    id_product_attribute: rawRow.id_product_attribute,
    id_shop: rawRow.id_shop || "1",
    quantity: expectedQuantity,
    depends_on_stock: rawRow.depends_on_stock || "0",
    out_of_stock: rawRow.out_of_stock || "2",
  };
  return apiPut(`stock_availables/${rawRow.id}`, "stock_available", body);
}

export async function run(productIds) {
  const stateCache = new Map();
  let flagged = 0;
  for (const idProduct of productIds) {
    for (const raw of await stockAvailableRows(idProduct)) {
      const idProductAttribute = raw.id_product_attribute;
      const stockRow = {
        quantity: Number(raw.quantity),
        physicalQuantity: Number(raw.physical_quantity),
        reservedQuantity: Number(raw.reserved_quantity),
      };
      const computedReserved = await computeReservedQuantity(idProduct, idProductAttribute, stateCache);
      const result = checkStockInvariant(stockRow, computedReserved);
      if (result.inSync) continue;
      flagged++;
      console.warn(
        `Product ${idProduct} attribute ${idProductAttribute} out of sync. stored quantity=${stockRow.quantity} ` +
          `physical=${stockRow.physicalQuantity} reserved=${stockRow.reservedQuantity} computed_reserved=${computedReserved} ` +
          `expected_quantity=${result.expectedQuantity} formulaViolation=${result.formulaViolation} reservedMismatch=${result.reservedMismatch}`
      );
      if (!DRY_RUN) {
        await repairQuantity(raw, result.expectedQuantity);
        console.log(
          `Wrote stock_availables/${raw.id} quantity=${result.expectedQuantity}. reserved_quantity and ` +
            `physical_quantity left untouched; re-trigger the correct order_histories transition or run a ` +
            `back-office stock regularization to fix the underlying drift.`
        );
      }
    }
  }
  console.log(`Done. ${flagged} stock row(s) ${DRY_RUN ? "flagged" : "flagged and repaired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const productIdsEnv = process.env.PRODUCT_IDS || "";
  const ids = productIdsEnv.split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) {
    console.error("Set PRODUCT_IDS to a comma separated list of id_product values to check.");
    process.exit(1);
  } else {
    run(ids).catch((err) => { console.error(err); process.exit(1); });
  }
}
