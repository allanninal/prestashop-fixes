/**
 * Audit PrestaShop multistore orders for tax calculated at the wrong country's rate.
 *
 * Each shop in a multistore install has its own default country, but the tax
 * engine is supposed to resolve the rate from the invoice address's
 * id_country through PS_TAX_ADDRESS_TYPE and the TaxRulesGroup/TaxManager
 * classes. When the address is incomplete, when an order arrives through
 * pickup in store or the webservice without a full id_address_invoice, or
 * when a price context falls back to the shop's own country, the
 * TaxManager can silently use the shop's default country tax rule instead
 * of the customer's real one.
 *
 * This script reads a range of orders, recomputes the expected tax from
 * each order line's id_tax_rules_group and the invoice address's real
 * id_country, and compares it to the stored total_paid_tax_incl. It only
 * writes an audit report by default. A stored total tied to an invoice
 * must never be auto-corrected in place, so DRY_RUN=false only offers a
 * repair path for orders still in an editable, unpaid current_state, and
 * even then requires an explicit human confirmation before it writes
 * anything.
 *
 * Guide: https://www.allanninal.dev/prestashop/multistore-wrong-country-tax-rate/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const ID_ORDER_START = Number(process.env.ID_ORDER_START || 1);
const ID_ORDER_END = Number(process.env.ID_ORDER_END || 1);
const EDITABLE_STATE_NAMES = new Set(["awaiting payment", "awaiting check payment", "awaiting bank wire payment"]);

const EPSILON = 0.02;

function authHeader() {
  return "Basic " + Buffer.from(`${WS_KEY}:`).toString("base64");
}

export function computeExpectedTax(unitPriceTaxExcl, quantity, taxRatePct) {
  const expectedTaxExclTotal = Math.round(unitPriceTaxExcl * quantity * 100) / 100;
  const expectedTaxInclTotal = Math.round(expectedTaxExclTotal * (1 + taxRatePct / 100) * 100) / 100;
  return expectedTaxInclTotal;
}

export function selectApplicableTaxRate(orderCountryId, shopDefaultCountryId, taxRules) {
  for (const rule of taxRules) {
    if (Number(rule.id_country) === Number(orderCountryId)) return Number(rule.rate);
  }
  for (const rule of taxRules) {
    if (Number(rule.id_country) === Number(shopDefaultCountryId)) return Number(rule.rate);
  }
  return 0;
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

async function apiPost(path, body) {
  const res = await fetch(`${PRESTASHOP_URL}/api/${path}?output_format=JSON`, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function getOrder(idOrder) {
  const data = await apiGet(`orders/${idOrder}`, { display: "full" });
  return data.order || {};
}

async function getAddressCountry(idAddress) {
  const data = await apiGet(`addresses/${idAddress}`, { display: "full" });
  const raw = data.address?.id_country;
  return raw ? Number(raw) : null;
}

async function getOrderLines(idOrder) {
  const data = await apiGet("order_details", {
    "filter[id_order]": idOrder,
    display: "full",
  });
  return data.order_details || [];
}

async function getTaxRules(idTaxRulesGroup) {
  const data = await apiGet("tax_rules", {
    "filter[id_tax_rules_group]": idTaxRulesGroup,
    display: "full",
  });
  return data.tax_rules || [];
}

async function isEditableState(idOrderState) {
  const data = await apiGet(`order_states/${idOrderState}`, { display: "full" });
  let name = data.order_state?.name;
  if (name && typeof name === "object") name = Object.values(name)[0];
  return EDITABLE_STATE_NAMES.has(String(name || "").trim().toLowerCase());
}

async function scanOrder(idOrder) {
  const order = await getOrder(idOrder);
  const idShop = Number(order.id_shop || 0);
  const idAddressInvoice = Number(order.id_address_invoice || 0);
  const storedTotal = Number(order.total_paid_tax_incl || 0);
  const currentState = Number(order.current_state || 0);

  const orderCountryId = await getAddressCountry(idAddressInvoice);
  const shopData = await apiGet(`shops/${idShop}`, { display: "full" });
  const shopDefaultCountryId = Number(shopData.shop?.id_country || orderCountryId || 0);

  const lines = await getOrderLines(idOrder);
  let expectedTotal = 0;
  const lineFindings = [];
  for (const line of lines) {
    const idTaxRulesGroup = Number(line.id_tax_rules_group || 0);
    const unitPrice = Number(line.unit_price_tax_excl || 0);
    const quantity = Number(line.product_quantity || 0);
    const taxRules = await getTaxRules(idTaxRulesGroup);
    const rate = selectApplicableTaxRate(orderCountryId, shopDefaultCountryId, taxRules);
    const expectedLineTotal = computeExpectedTax(unitPrice, quantity, rate);
    expectedTotal += expectedLineTotal;
    lineFindings.push({
      id_order_detail: line.id,
      id_tax_rules_group: idTaxRulesGroup,
      unit_price_tax_excl: unitPrice,
      product_quantity: quantity,
      expected_rate: rate,
      expected_total_price_tax_incl: expectedLineTotal,
    });
  }

  if (Math.abs(storedTotal - expectedTotal) <= EPSILON) return null;

  return {
    id_order: idOrder,
    id_shop: idShop,
    id_address_invoice: idAddressInvoice,
    order_country_id: orderCountryId,
    shop_default_country_id: shopDefaultCountryId,
    current_state: currentState,
    stored_total_paid_tax_incl: storedTotal,
    expected_total_paid_tax_incl: Math.round(expectedTotal * 100) / 100,
    lines: lineFindings,
  };
}

async function applyCorrection(finding, confirmed) {
  if (!confirmed) {
    console.log(`Order ${finding.id_order}: correction available but not confirmed, skipping write.`);
    return;
  }
  if (!(await isEditableState(finding.current_state))) {
    console.warn(`Order ${finding.id_order}: current_state ${finding.current_state} is not editable, refusing to write.`);
    return;
  }

  for (const line of finding.lines) {
    await apiPut(`order_details/${line.id_order_detail}`, {
      total_price_tax_incl: line.expected_total_price_tax_incl,
      total_price_tax_excl: Math.round(line.unit_price_tax_excl * line.product_quantity * 100) / 100,
      unit_price_tax_incl: Math.round((line.expected_total_price_tax_incl / Math.max(line.product_quantity, 1)) * 100) / 100,
    });
  }

  const totalExcl = finding.lines.reduce((sum, l) => sum + l.unit_price_tax_excl * l.product_quantity, 0);
  await apiPut(`orders/${finding.id_order}`, {
    total_paid_tax_incl: finding.expected_total_paid_tax_incl,
    total_paid: finding.expected_total_paid_tax_incl,
    total_paid_tax_excl: Math.round(totalExcl * 100) / 100,
  });

  await apiPost("order_histories", {
    id_order: finding.id_order,
    id_order_state: finding.current_state,
  });
  console.log(`Order ${finding.id_order}: corrected to expected total ${finding.expected_total_paid_tax_incl.toFixed(2)}.`);
}

export async function run() {
  const findings = [];
  for (let idOrder = ID_ORDER_START; idOrder <= ID_ORDER_END; idOrder++) {
    const finding = await scanOrder(idOrder);
    if (finding) {
      findings.push(finding);
      console.warn(
        `Order ${finding.id_order} (shop ${finding.id_shop}): stored total_paid_tax_incl ${finding.stored_total_paid_tax_incl.toFixed(2)}, expected ${finding.expected_total_paid_tax_incl.toFixed(2)} for country ${finding.order_country_id}.`
      );
      if (!DRY_RUN) await applyCorrection(finding, false);
    }
  }
  console.log(`Done. ${findings.length} order(s) flagged for review.`);
  return findings;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
