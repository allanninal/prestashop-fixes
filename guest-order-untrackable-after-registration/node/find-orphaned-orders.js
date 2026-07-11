/**
 * Detect PrestaShop guest orders orphaned after the same email registers a real account.
 *
 * A guest checkout creates a customers row with is_guest=1, and the resulting order stores
 * that row's id as a fixed id_customer foreign key. When the same person later registers a
 * full account with the identical email, either through the "create an account" link in the
 * order confirmation or guest-tracking email, or by registering fresh at checkout, PrestaShop
 * does not always detect the existing guest record and transform it in place. It can instead
 * create a second, separate customers row with is_guest=0 and a new id. The old guest order's
 * id_customer keeps pointing at the original guest customer id, so the order never appears in
 * the new logged-in account's order history even though the emails match exactly.
 *
 * This script only reads and reports by default. Relinking an order to a different id_customer
 * touches financial and order records directly, and PrestaShop's own core has open bugs in this
 * exact area, so it is unsafe for an unattended script to do automatically. The only write this
 * script ever performs is changing id_customer on an order already confirmed orphaned, and only
 * when DRY_RUN is explicitly set to false. The guest customers row itself is never deleted or
 * merged, since that decision has GDPR implications and stays with a human.
 *
 * Guide: https://www.allanninal.dev/prestashop/guest-order-untrackable-after-registration/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * Pure decision function, no I/O.
 *
 * guestCustomers is an array of customer objects with is_guest=1, realCustomers is an array
 * of customer objects with is_guest=0, and orders is an array of already-fetched order
 * objects. Groups both customer lists by lowercased and trimmed email. For each email
 * present in both groups, takes the guest's id_customer and the real account's id_customer,
 * filters orders where order.id_customer equals the guest id, and returns an array of
 * {id_order, current_id_customer, target_id_customer, email} objects, one per orphaned
 * order, ready to hand to the guarded repair step.
 */
export function findOrphanedGuestOrders(guestCustomers, realCustomers, orders) {
  const guestByEmail = new Map();
  for (const c of guestCustomers) {
    const key = normalizeEmail(c.email);
    if (!guestByEmail.has(key)) guestByEmail.set(key, []);
    guestByEmail.get(key).push(c);
  }

  const realByEmail = new Map();
  for (const c of realCustomers) {
    const key = normalizeEmail(c.email);
    if (!realByEmail.has(key)) realByEmail.set(key, []);
    realByEmail.get(key).push(c);
  }

  const plan = [];
  for (const [email, guestRows] of guestByEmail) {
    const realRows = realByEmail.get(email);
    if (!realRows || realRows.length === 0) continue;
    const guestId = guestRows[0].id;
    const realId = realRows[0].id;
    for (const order of orders) {
      if (String(order.id_customer) === String(guestId)) {
        plan.push({
          id_order: order.id,
          current_id_customer: guestId,
          target_id_customer: realId,
          email,
        });
      }
    }
  }
  return plan;
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function guestCustomers() {
  const data = await apiGet("customers", { "filter[is_guest]": "1", display: "full" });
  return data.customers || [];
}

async function realCustomers() {
  const data = await apiGet("customers", { "filter[is_guest]": "0", display: "full" });
  return data.customers || [];
}

async function ordersForCustomer(idCustomer) {
  const data = await apiGet("orders", { "filter[id_customer]": idCustomer, display: "full" });
  return data.orders || [];
}

async function relinkOrder(idOrder, targetIdCustomer) {
  const data = await apiGet(`orders/${idOrder}`, { display: "full" });
  const order = data.order;
  order.id_customer = targetIdCustomer;
  const res = await fetch(`${PRESTASHOP_URL}/api/orders/${idOrder}?output_format=JSON`, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ order }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT orders/${idOrder}`);
  return res.json();
}

export async function run() {
  const guests = await guestCustomers();
  const reals = await realCustomers();

  const realEmails = new Set(reals.map((c) => normalizeEmail(c.email)));
  const candidateGuestIds = guests
    .filter((c) => realEmails.has(normalizeEmail(c.email)))
    .map((c) => c.id);

  const orders = [];
  for (const guestId of candidateGuestIds) {
    orders.push(...(await ordersForCustomer(guestId)));
  }

  const plan = findOrphanedGuestOrders(guests, reals, orders);

  for (const entry of plan) {
    console.warn(
      `Orphaned guest order found. id_order=${entry.id_order} ` +
        `from_id_customer=${entry.current_id_customer} to_id_customer=${entry.target_id_customer} ` +
        `email=${entry.email} ${DRY_RUN ? "(dry run, not applied)" : "(relinking)"}`
    );
    if (!DRY_RUN) await relinkOrder(entry.id_order, entry.target_id_customer);
  }

  console.log(
    `Done. ${plan.length} orphaned order(s) found. DRY_RUN=${DRY_RUN} (relink only applied ` +
      `when explicitly false, and never merges or deletes the guest customer row).`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
