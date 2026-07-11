/**
 * Detect PrestaShop products whose live price resolution disagrees with the
 * best legitimate price a customer actually qualifies for.
 *
 * PrestaShop resolves a product's effective price by scanning specific_price rows
 * (and specific_price_rule catalog rules) that match the request context, id_shop,
 * id_currency, id_country, id_group, id_customer, and picking the first one that
 * matches according to a fixed priority order: Shop, then Currency, then Country,
 * then Group, and within Group the most specific id_group or id_customer is meant
 * to beat "all groups" or "all customers." It does not compute every matching rule
 * and choose the numerically lowest resulting price. Because All Groups
 * (id_group=0) and generic country or currency wildcards sit in a priority
 * position that is not strictly "more specific wins," a broader rule can be
 * selected over a narrower, better rule that actually applies to the customer's
 * real group or currency. Confirmed in PrestaShop/PrestaShop issue #33736 and the
 * related discussion in #33440 and #14516 on specific_price versus catalog rule
 * priority.
 *
 * This is a core pricing-engine priority-resolution defect, not a bad data row,
 * so the default action is to flag every mismatch for manual review. A
 * DRY_RUN-guarded repair is available only for a single, operator-confirmed
 * superseded specific_price row, targeted by its own id, never a bulk delete.
 *
 * Guide: https://www.allanninal.dev/prestashop/specific-price-priority-wrong/
 *
 * Run on a schedule. Safe to run again and again.
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const STALE_ROW_ID = process.env.CONFIRMED_STALE_SPECIFIC_PRICE_ID || "";

const EPSILON = 0.01;
const ZERO_DATE_PREFIX = "0000-00-00";

function dateOpen(value) {
  return !value || String(value).startsWith(ZERO_DATE_PREFIX);
}

/**
 * Pure decision function, no I/O.
 *
 * basePrice: pre-tax product price (number).
 * candidateRules: array of objects, each with idGroup, idCurrency, idCountry,
 * idCustomer, reduction, reductionType ('amount' or 'percentage'), fromQuantity,
 * from (date string or null/zero-date), to (date string or null/zero-date).
 * context: object with customerGroupIds (array of number), currencyId,
 * countryId, customerId, quantity, now (PrestaShop "YYYY-MM-DD HH:MM:SS" string,
 * compared lexicographically, which works because that format sorts the same
 * lexicographically as chronologically).
 *
 * Filters candidateRules to the ones matching context, computes each matching
 * rule's resulting unit price, and returns { bestPrice, winningRuleIndex }: the
 * numerically lowest resulting price (the customer-optimal price) and which
 * rule produced it, or winningRuleIndex null if no rule matches, meaning
 * basePrice applies as-is.
 */
export function resolveBestSpecificPrice(basePrice, candidateRules, context) {
  const groupIds = new Set(context.customerGroupIds || []);
  let bestPrice = null;
  let winningIndex = null;

  candidateRules.forEach((rule, index) => {
    if (rule.idGroup !== 0 && !groupIds.has(rule.idGroup)) return;
    if (rule.idCurrency !== 0 && rule.idCurrency !== context.currencyId) return;
    if (rule.idCountry !== 0 && rule.idCountry !== context.countryId) return;
    if (rule.idCustomer !== 0 && rule.idCustomer !== context.customerId) return;
    if (context.quantity < rule.fromQuantity) return;
    if (!dateOpen(rule.from) && context.now < rule.from) return;
    if (!dateOpen(rule.to) && context.now > rule.to) return;

    const price = rule.reductionType === "percentage"
      ? basePrice * (1 - rule.reduction)
      : basePrice - rule.reduction;

    if (bestPrice === null || price < bestPrice) {
      bestPrice = price;
      winningIndex = index;
    }
  });

  if (bestPrice === null) return { bestPrice: basePrice, winningRuleIndex: null };
  return { bestPrice, winningRuleIndex: winningIndex };
}

/**
 * Pure decision function, no I/O.
 *
 * Returns true when the store served a worse (higher) price than what the
 * customer legitimately qualifies for, beyond a currency-rounding epsilon.
 */
export function findPriceMismatch(recalculatedBestPrice, apiReportedPrice) {
  return (apiReportedPrice - recalculatedBestPrice) > EPSILON;
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

async function apiDelete(path) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  const res = await fetch(url, { method: "DELETE", headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on DELETE ${path}`);
}

async function customerGroupIds(idCustomer) {
  const data = await apiGet(`customers/${idCustomer}`, { display: "full" });
  const customer = data.customer || {};
  const groups = (customer.associations && customer.associations.groups) || [];
  const ids = new Set(groups.filter((g) => g.id).map((g) => Number(g.id)));
  if (customer.id_default_group) ids.add(Number(customer.id_default_group));
  return ids;
}

async function productBasePrice(idProduct) {
  const data = await apiGet(`products/${idProduct}`, { display: "full" });
  const product = data.product || {};
  return Number(product.price || 0);
}

async function specificPricesFor(idProduct) {
  const data = await apiGet("specific_prices", { "filter[id_product]": idProduct, display: "full" });
  return data.specific_prices || [];
}

async function specificPriceRules() {
  const data = await apiGet("specific_price_rules", { display: "full" });
  return data.specific_price_rules || [];
}

async function apiReportedPrice(idProduct, idCustomer, idCurrency) {
  const data = await apiGet(`products/${idProduct}`, {
    display: "full",
    id_customer: idCustomer,
    id_currency: idCurrency,
  });
  const product = data.product || {};
  return Number(product.price || 0);
}

function normalizeRule(row) {
  return {
    idGroup: Number(row.id_group || 0),
    idCurrency: Number(row.id_currency || 0),
    idCountry: Number(row.id_country || 0),
    idCustomer: Number(row.id_customer || 0),
    reduction: Number(row.reduction || 0),
    reductionType: row.reduction_type || "amount",
    fromQuantity: Number(row.from_quantity || 1),
    from: row.from,
    to: row.to,
    id: row.id,
  };
}

async function checkProductForCustomer(idProduct, idCustomer, currencyId, countryId, quantity, now) {
  const basePrice = await productBasePrice(idProduct);
  const rows = (await specificPricesFor(idProduct)).map(normalizeRule);
  const context = {
    customerGroupIds: await customerGroupIds(idCustomer),
    currencyId,
    countryId,
    customerId: idCustomer,
    quantity,
    now,
  };
  const result = resolveBestSpecificPrice(basePrice, rows, context);
  const served = await apiReportedPrice(idProduct, idCustomer, currencyId);
  const mismatched = findPriceMismatch(result.bestPrice, served);
  return {
    idProduct,
    idCustomer,
    recalculatedBestPrice: result.bestPrice,
    winningRuleIndex: result.winningRuleIndex,
    winningRule: result.winningRuleIndex !== null ? rows[result.winningRuleIndex] : null,
    apiReportedPrice: served,
    mismatched,
  };
}

async function repairConfirmedStaleRow(specificPriceId) {
  // Only ever targets a single, operator-confirmed superseded specific_price id.
  // Never a bulk delete, never called automatically without
  // CONFIRMED_STALE_SPECIFIC_PRICE_ID being explicitly set.
  console.warn(
    `${DRY_RUN ? "DRY RUN" : "REPAIRING"} specific_prices/${specificPriceId}: would DELETE this single confirmed-stale row`
  );
  if (!DRY_RUN) await apiDelete(`specific_prices/${specificPriceId}`);
}

export async function run(pairs = []) {
  // pairs is an array of [idProduct, idCustomer, currencyId, countryId, quantity, now].
  // Populate this from your own source of "customers who recently viewed or
  // ordered this product," since the webservice has no single endpoint that
  // enumerates every live combination on its own.
  let flagged = 0;
  for (const [idProduct, idCustomer, currencyId, countryId, quantity, now] of pairs) {
    const row = await checkProductForCustomer(idProduct, idCustomer, currencyId, countryId, quantity, now);
    if (row.mismatched) {
      flagged++;
      console.warn(
        `Price mismatch. id_product=${row.idProduct} id_customer=${row.idCustomer} ` +
          `recalculated_best_price=${row.recalculatedBestPrice.toFixed(2)} ` +
          `api_reported_price=${row.apiReportedPrice.toFixed(2)} winning_rule=${JSON.stringify(row.winningRule)}`
      );
    }
  }
  if (STALE_ROW_ID) await repairConfirmedStaleRow(STALE_ROW_ID);
  console.log(`Done. ${flagged} id_product/id_customer pair(s) flagged for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
