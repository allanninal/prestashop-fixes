"""Detect PrestaShop guest orders orphaned after the same email registers a real account.

A guest checkout creates a customers row with is_guest=1, and the resulting order stores
that row's id as a fixed id_customer foreign key. When the same person later registers a
full account with the identical email, either through the "create an account" link in the
order confirmation or guest-tracking email, or by registering fresh at checkout, PrestaShop
does not always detect the existing guest record and transform it in place. It can instead
create a second, separate customers row with is_guest=0 and a new id. The old guest order's
id_customer keeps pointing at the original guest customer id, so the order never appears in
the new logged-in account's order history even though the emails match exactly.

This script only reads and reports by default. Relinking an order to a different id_customer
touches financial and order records directly, and PrestaShop's own core has open bugs in this
exact area, so it is unsafe for an unattended script to do automatically. The only write this
script ever performs is changing id_customer on an order already confirmed orphaned, and only
when DRY_RUN is explicitly set to false. The guest customers row itself is never deleted or
merged, since that decision has GDPR implications and stays with a human.

Guide: https://www.allanninal.dev/prestashop/guest-order-untrackable-after-registration/

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_orphaned_orders")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def normalize_email(email):
    return str(email or "").strip().lower()


def find_orphaned_guest_orders(guest_customers, real_customers, orders):
    """Pure decision function, no I/O.

    guest_customers is a list of customer dicts with is_guest=1, real_customers is a list
    of customer dicts with is_guest=0, and orders is a list of already-fetched order dicts.
    Groups both customer lists by lowercased and trimmed email. For each email present in
    both groups, takes the guest's id_customer and the real account's id_customer, filters
    orders where order['id_customer'] equals the guest id, and returns a list of
    {id_order, current_id_customer, target_id_customer, email} dicts, one per orphaned
    order, ready to hand to the guarded repair step.
    """
    guest_by_email = {}
    for c in guest_customers:
        guest_by_email.setdefault(normalize_email(c.get("email")), []).append(c)

    real_by_email = {}
    for c in real_customers:
        real_by_email.setdefault(normalize_email(c.get("email")), []).append(c)

    plan = []
    for email, guest_rows in guest_by_email.items():
        real_rows = real_by_email.get(email)
        if not real_rows:
            continue
        guest_id = guest_rows[0].get("id")
        real_id = real_rows[0].get("id")
        for order in orders:
            if str(order.get("id_customer")) == str(guest_id):
                plan.append({
                    "id_order": order.get("id"),
                    "current_id_customer": guest_id,
                    "target_id_customer": real_id,
                    "email": email,
                })
    return plan


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def guest_customers():
    data = api_get("customers", params={"filter[is_guest]": "1", "display": "full"})
    return data.get("customers") or []


def real_customers():
    data = api_get("customers", params={"filter[is_guest]": "0", "display": "full"})
    return data.get("customers") or []


def orders_for_customer(id_customer):
    data = api_get("orders", params={"filter[id_customer]": id_customer, "display": "full"})
    return data.get("orders") or []


def relink_order(id_order, target_id_customer):
    data = api_get(f"orders/{id_order}", params={"display": "full"})
    order = data["order"]
    order["id_customer"] = target_id_customer
    r = requests.put(
        f"{PRESTASHOP_URL}/api/orders/{id_order}",
        params={"output_format": "JSON"},
        json={"order": order},
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    guests = guest_customers()
    reals = real_customers()

    real_emails = {normalize_email(c.get("email")) for c in reals}
    candidate_guest_ids = [
        c.get("id") for c in guests if normalize_email(c.get("email")) in real_emails
    ]

    orders = []
    for guest_id in candidate_guest_ids:
        orders.extend(orders_for_customer(guest_id))

    plan = find_orphaned_guest_orders(guests, reals, orders)

    for entry in plan:
        log.warning(
            "Orphaned guest order found. id_order=%s from_id_customer=%s to_id_customer=%s email=%s %s",
            entry["id_order"], entry["current_id_customer"], entry["target_id_customer"],
            entry["email"], "(dry run, not applied)" if DRY_RUN else "(relinking)",
        )
        if not DRY_RUN:
            relink_order(entry["id_order"], entry["target_id_customer"])

    log.info(
        "Done. %d orphaned order(s) found. DRY_RUN=%s (relink only applied when explicitly "
        "false, and never merges or deletes the guest customer row).",
        len(plan), DRY_RUN,
    )


if __name__ == "__main__":
    run()
