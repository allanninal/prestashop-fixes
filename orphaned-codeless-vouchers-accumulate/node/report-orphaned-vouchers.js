/**
 * Find PrestaShop cart rules that were created with no code, auto-apply to qualifying
 * carts, and are now permanently unusable because their quantity ran out, their date_to
 * passed, or they were deactivated.
 *
 * These codeless rules are matched by conditions rather than a customer-typed string, so
 * the back office has never had a reliable way to know it is safe to offer a delete
 * affordance for one (PrestaShop core issues #12608 and #20246). Once dead, they are
 * never purged, so they pile up in the cart_rule table and clutter admin listings and
 * reports.
 *
 * This script only reports by default. The optional, DRY_RUN-guarded delete step only
 * fires for ids a human lists in CONFIRMED_DELETE_IDS after reviewing the report, and
 * even then only after re-confirming order_cart_rules has zero rows for that id, since a
 * rule that is dead going forward can still be the rule a real, already finalized order
 * used. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/prestashop/orphaned-codeless-vouchers-accumulate/
 */
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const BASE_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/$/, "");
const WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const REPORT_PATH = process.env.REPORT_PATH || "orphaned_vouchers_report.csv";
const CONFIRMED_DELETE_IDS = new Set(
  (process.env.CONFIRMED_DELETE_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number)
);

// Pure decision: true when a cart rule is codeless AND (exhausted, expired, or
// disabled). A rule with a real code is never orphaned by this rule, regardless of
// quantity, dateTo, or active. No I/O, no network, no side effects.
export function isOrphanedCodelessVoucher(code, quantity, dateTo, active, today) {
  if (code.trim() !== "") return false;
  if (quantity <= 0) return true;
  if (dateTo) {
    const parsed = new Date(String(dateTo).split(" ")[0] + "T00:00:00Z");
    if (parsed < today) return true;
  }
  if (active === false) return true;
  return false;
}

function authHeader() {
  return "Basic " + Buffer.from(`${WS_KEY}:`).toString("base64");
}

async function apiGet(path, params = {}) {
  const qs = new URLSearchParams({ ...params, output_format: "JSON" });
  const res = await fetch(`${BASE_URL}/api/${path}?${qs}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(`${BASE_URL}/api/${path}?output_format=JSON`, {
    method: "DELETE",
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status}`);
  return res.status;
}

async function listCartRules(limit = 1000) {
  const data = await apiGet("cart_rules", { display: "full", limit });
  const rules = data.cart_rules || [];
  return rules.map((rule) => ({
    id: Number(rule.id),
    name: rule.name || "",
    code: rule.code || "",
    quantity: Number(rule.quantity),
    quantityPerUser: Number(rule.quantity_per_user),
    dateFrom: rule.date_from,
    dateTo: rule.date_to,
    active: rule.active === "1" || rule.active === 1 || rule.active === true,
  }));
}

async function hasHistoricalOrder(cartRuleId) {
  const data = await apiGet("order_cart_rules", { "filter[id_cart_rule]": cartRuleId, display: "full" });
  const links = data.order_cart_rules || [];
  return links.length > 0;
}

function writeReport(rows, path) {
  const header = "id_cart_rule,name,date_from,date_to,quantity,quantity_per_user";
  const lines = rows.map((r) =>
    [r.idCartRule, r.name, r.dateFrom, r.dateTo, r.quantity, r.quantityPerUser]
      .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
      .join(",")
  );
  writeFileSync(path, [header, ...lines].join("\n") + "\n");
}

export async function run() {
  const today = new Date();
  const candidates = [];

  for (const rule of await listCartRules()) {
    if (!isOrphanedCodelessVoucher(rule.code, rule.quantity, rule.dateTo, rule.active, today)) continue;
    if (await hasHistoricalOrder(rule.id)) {
      console.log(`Cart rule ${rule.id} (${rule.name}) is codeless and dead but still referenced by a historical order, skipping.`);
      continue;
    }
    candidates.push({
      idCartRule: rule.id,
      name: rule.name,
      dateFrom: rule.dateFrom,
      dateTo: rule.dateTo,
      quantity: rule.quantity,
      quantityPerUser: rule.quantityPerUser,
    });
  }

  writeReport(candidates, REPORT_PATH);
  console.log(`Report written to ${REPORT_PATH} with ${candidates.length} orphaned codeless voucher(s).`);

  if (DRY_RUN || CONFIRMED_DELETE_IDS.size === 0) {
    console.log("Dry run or no confirmed ids. No cart rule was deleted.");
    return;
  }

  const candidateIds = new Set(candidates.map((row) => row.idCartRule));
  for (const cartRuleId of [...CONFIRMED_DELETE_IDS].sort((a, b) => a - b)) {
    if (!candidateIds.has(cartRuleId)) {
      console.warn(`Confirmed id ${cartRuleId} is not in this run's report, skipping.`);
      continue;
    }
    if (await hasHistoricalOrder(cartRuleId)) {
      console.warn(`Confirmed id ${cartRuleId} now shows a historical order reference, skipping delete.`);
      continue;
    }
    await apiDelete(`cart_rules/${cartRuleId}`);
    console.log(`Deleted cart rule ${cartRuleId}.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
