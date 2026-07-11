/**
 * Detect PrestaShop multistore currency rates that were overwritten across shops.
 *
 * PrestaShop stores a currency's exchange rate as a single conversion_rate column
 * on the ps_currency row for that currency id. Shops are linked to currencies
 * through ps_currency_shop, but that table only controls enable and disable
 * state, it has no rate column. So editing a rate for one shop context, or
 * letting cron_currency_rates.php run, writes the one shared column and every
 * shop using that currency id instantly inherits the new value (PrestaShop/
 * PrestaShop issues #23447 and #12025, closed as expected as is).
 *
 * This script snapshots each shop's view of every currency's rate, keyed by
 * "id_shop:id_currency", and compares the new snapshot against the last one on
 * disk. When shops that used to disagree on a currency's rate now report the
 * identical rate, it is very likely an overwrite happened, and this is reported.
 * There is no safe automatic repair: restoring one shop's rate rewrites the same
 * shared column and would re-break every other shop again, so any corrective PUT
 * stays behind DRY_RUN and is a human decision.
 *
 * Guide: https://www.allanninal.dev/prestashop/exchange-rate-overwritten-across-shops/
 *
 * Run on a schedule. Safe to run again and again.
 */
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const SNAPSHOT_FILE = process.env.SNAPSHOT_FILE || "rate_snapshot.json";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * previousSnapshot, currentSnapshot: plain objects mapping "id_shop:id_currency"
 *   to conversion_rate.
 * tolerance: number, how close two rates must be to count as identical.
 *
 * Returns a list of findings, each an object with idCurrency,
 * idShopsCollapsed, oldRates, newRate, and likelySourceShop.
 * A finding is emitted when two or more shops that previously disagreed on
 * a currency's rate now report the identical rate, and that rate matches
 * the rate most recently written in exactly one shop (the likely source).
 */
export function detectRateOverwrite(previousSnapshot, currentSnapshot, tolerance = 1e-6) {
  const byCurrency = new Map();
  for (const [key, rate] of Object.entries(currentSnapshot)) {
    const [idShop, idCurrency] = key.split(":").map(Number);
    if (!byCurrency.has(idCurrency)) byCurrency.set(idCurrency, []);
    byCurrency.get(idCurrency).push([idShop, rate]);
  }

  const findings = [];
  for (const [idCurrency, shopRates] of byCurrency) {
    const priorRates = {};
    for (const [idShop] of shopRates) {
      const priorKey = `${idShop}:${idCurrency}`;
      if (priorKey in previousSnapshot) priorRates[idShop] = previousSnapshot[priorKey];
    }
    if (!hasDisagreement(Object.values(priorRates), tolerance)) continue;

    for (const group of groupByTolerance(shopRates, tolerance)) {
      const shopsNow = group.map(([idShop]) => idShop);
      const newRate = group[0][1];
      const disagreeingBefore = shopsNow.filter(
        (s) => s in priorRates && Math.abs(priorRates[s] - newRate) > tolerance
      );
      if (disagreeingBefore.length >= 2) {
        const sourceCandidates = shopsNow.filter(
          (s) => s in priorRates && Math.abs(priorRates[s] - newRate) <= tolerance
        );
        findings.push({
          idCurrency,
          idShopsCollapsed: disagreeingBefore.slice().sort((a, b) => a - b),
          oldRates: Object.fromEntries(disagreeingBefore.map((s) => [s, priorRates[s]])),
          newRate,
          likelySourceShop: sourceCandidates.length === 1 ? sourceCandidates[0] : null,
        });
      }
    }
  }
  return findings;
}

/** True when the given rates are not all within tolerance of each other. */
function hasDisagreement(rates, tolerance) {
  if (rates.length < 2) return false;
  const base = rates[0];
  return rates.slice(1).some((r) => Math.abs(r - base) > tolerance);
}

/**
 * Group [idShop, rate] pairs into clusters whose rates are mutually within
 * tolerance of each other. Simple, order-independent clustering that is
 * adequate for the small number of shops a currency has.
 */
function groupByTolerance(shopRates, tolerance) {
  const groups = [];
  for (const [idShop, rate] of shopRates) {
    const group = groups.find((g) => Math.abs(g[0][1] - rate) <= tolerance);
    if (group) group.push([idShop, rate]);
    else groups.push([[idShop, rate]]);
  }
  return groups;
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function allShopIds() {
  const data = await apiGet("shops", { display: "full" });
  const rows = data.shops || [];
  return rows.map((row) => Number(row.id));
}

async function currenciesForShop(idShop) {
  const data = await apiGet("currencies", {
    display: "full",
    "filter[active]": "1",
    id_shop: idShop,
  });
  return data.currencies || [];
}

async function buildSnapshot(shopIds) {
  const snapshot = {};
  for (const idShop of shopIds) {
    for (const row of await currenciesForShop(idShop)) {
      const key = `${Number(idShop)}:${Number(row.id)}`;
      snapshot[key] = Number(row.conversion_rate);
    }
  }
  return snapshot;
}

function loadSnapshot(path) {
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  const snapshot = {};
  for (const item of raw.entries || []) {
    snapshot[`${Number(item.id_shop)}:${Number(item.id_currency)}`] = Number(item.conversion_rate);
  }
  return snapshot;
}

function saveSnapshot(path, snapshot) {
  const entries = Object.entries(snapshot).map(([key, rate]) => {
    const [idShop, idCurrency] = key.split(":").map(Number);
    return { id_shop: idShop, id_currency: idCurrency, conversion_rate: rate };
  });
  writeFileSync(path, JSON.stringify({ entries }, null, 2));
}

async function apiPutRestoreRate(idCurrency, currencyBody, restoredRate) {
  // Restoring one shop's rate rewrites the single shared conversion_rate
  // column, which will simultaneously re-break every other shop sharing
  // this currency id. Only call this after a human has confirmed which
  // rate is authoritative, and never from an automatic branch.
  const body = { ...currencyBody, conversion_rate: restoredRate };
  const url = new URL(`${PRESTASHOP_URL}/api/currencies/${idCurrency}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ currency: body }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT currencies/${idCurrency}`);
  return res.json();
}

export async function run() {
  const shopIds = await allShopIds();
  const current = await buildSnapshot(shopIds);
  const previous = loadSnapshot(SNAPSHOT_FILE);

  const findings = detectRateOverwrite(previous, current);
  for (const f of findings) {
    console.warn(
      `Currency id=${f.idCurrency} rate collapsed to ${f.newRate} across shops ${JSON.stringify(f.idShopsCollapsed)}. old_rates=${JSON.stringify(f.oldRates)} likely_source_shop=${f.likelySourceShop}`
    );
    if (!DRY_RUN) {
      console.log(
        `DRY_RUN is false, but this script never auto-repairs currency id=${f.idCurrency}. Restoring one shop's rate would re-break every other shop sharing it. Decide the authoritative rate by hand, then call apiPutRestoreRate() explicitly.`
      );
    }
  }

  saveSnapshot(SNAPSHOT_FILE, current);
  console.log(`Done. ${findings.length} suspected overwrite(s) found across ${shopIds.length} shop(s).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
