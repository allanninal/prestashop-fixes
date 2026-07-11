/**
 * Detect PrestaShop customer accounts duplicated across the same email.
 *
 * PrestaShop enforces email uniqueness only in the front-office registration form's
 * validation layer, not as a database constraint or a webservice-level check, and guest
 * orders are exempt from that check entirely. Guest checkout creates a ps_customer row
 * with is_guest=1 for a given email. If the same visitor later checks out as guest
 * again, converts that guest to a registered account (CustomerCore's
 * transformGuestToCustomer), or an admin or webservice call creates a customer with an
 * email that already exists on a guest or non-guest row, PrestaShop inserts a second
 * ps_customer row instead of merging, because none of those code paths query for an
 * existing email before inserting.
 *
 * This script only reads and reports by default. Merging addresses, orders, cart rules,
 * and order history into one surviving id_customer is destructive and order-affecting,
 * so it is unsafe for an unattended script to do automatically. The only write this
 * script ever performs is a reversible soft-delete (deleted=1) of a duplicate row that
 * has zero associated orders, and only when DRY_RUN is explicitly set to false.
 *
 * Guide: https://www.allanninal.dev/prestashop/duplicate-customer-accounts-same-email/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 200);

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * Pure decision function, no I/O.
 *
 * customerRows is an array of customer objects (keys: id, email, is_guest, deleted,
 * date_add, order_count) that all share one normalized email. Returns null if one or
 * zero active (deleted=0) rows remain. Otherwise returns an object with email, keep_id
 * (the row with the highest order_count, ties broken by is_guest===false then earliest
 * date_add), duplicate_ids (every other active row), and a human-readable reason.
 */
export function pickMergeAction(customerRows) {
  const active = customerRows.filter((r) => String(r.deleted ?? "0") !== "1");
  if (active.length <= 1) return null;

  const ranked = [...active].sort((a, b) => {
    const oa = a.order_count || 0;
    const ob = b.order_count || 0;
    if (oa !== ob) return ob - oa;
    const ra = String(a.is_guest ?? "0") === "1" ? 0 : 1;
    const rb = String(b.is_guest ?? "0") === "1" ? 0 : 1;
    if (ra !== rb) return rb - ra;
    const da = a.date_add || "9999-99-99 99:99:99";
    const db = b.date_add || "9999-99-99 99:99:99";
    return da < db ? -1 : da > db ? 1 : 0;
  });

  const keep = ranked[0];
  const duplicates = ranked.slice(1);
  return {
    email: customerRows[0].email,
    keep_id: keep.id,
    duplicate_ids: duplicates.map((r) => r.id),
    reason: "highest order_count, then registered over guest, then earliest date_add",
  };
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function allCustomers(pageSize = PAGE_SIZE) {
  let offset = 0;
  const rows = [];
  while (true) {
    const data = await apiGet("customers", {
      display: "[id,email,is_guest,deleted,date_add]",
      limit: `${offset},${pageSize}`,
    });
    const page = data.customers || [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
    offset += pageSize;
  }
}

function groupByEmail(customers) {
  const groups = new Map();
  for (const c of customers) {
    const key = normalizeEmail(c.email);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const duplicates = {};
  for (const [email, rows] of groups) {
    if (rows.length > 1) duplicates[email] = rows;
  }
  return duplicates;
}

async function orderCountFor(idCustomer) {
  const data = await apiGet("orders", { "filter[id_customer]": idCustomer, display: "full" });
  return (data.orders || []).length;
}

async function softDeleteCustomer(idCustomer) {
  const data = await apiGet(`customers/${idCustomer}`, { display: "full" });
  const customer = data.customer;
  customer.deleted = "1";
  const res = await fetch(`${PRESTASHOP_URL}/api/customers/${idCustomer}?output_format=JSON`, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ customer }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT customers/${idCustomer}`);
  return res.json();
}

export async function run() {
  const customers = await allCustomers();
  const duplicateGroups = groupByEmail(customers);

  let flagged = 0;
  for (const [email, rows] of Object.entries(duplicateGroups)) {
    for (const row of rows) {
      row.order_count = await orderCountFor(row.id);
    }

    const action = pickMergeAction(rows);
    if (!action) continue;

    flagged++;
    console.warn(
      `Merge candidate found. email=${action.email} keep_id=${action.keep_id} ` +
        `duplicate_ids=${JSON.stringify(action.duplicate_ids)} reason=${action.reason}`
    );

    if (DRY_RUN) continue;

    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const dupId of action.duplicate_ids) {
      const row = byId.get(dupId);
      if ((row.order_count || 0) === 0) {
        console.warn(`Soft-deleting zero-order duplicate id_customer=${dupId}`);
        await softDeleteCustomer(dupId);
      } else {
        console.warn(
          `Skipping soft-delete for id_customer=${dupId}, it has order history. Manual merge required.`
        );
      }
    }
  }

  console.log(
    `Done. ${flagged} email(s) with duplicate customer accounts flagged. DRY_RUN=${DRY_RUN} ` +
      `(only zero-order duplicates are ever soft-deleted, never merged automatically).`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
