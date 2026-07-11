"""Detect PrestaShop customer accounts duplicated across the same email.

PrestaShop enforces email uniqueness only in the front-office registration form's
validation layer, not as a database constraint or a webservice-level check, and guest
orders are exempt from that check entirely. Guest checkout creates a ps_customer row
with is_guest=1 for a given email. If the same visitor later checks out as guest again,
converts that guest to a registered account (CustomerCore's transformGuestToCustomer),
or an admin or webservice call creates a customer with an email that already exists on
a guest or non-guest row, PrestaShop inserts a second ps_customer row instead of merging,
because none of those code paths query for an existing email before inserting.

This script only reads and reports by default. Merging addresses, orders, cart rules,
and order history into one surviving id_customer is destructive and order-affecting, so
it is unsafe for an unattended script to do automatically. The only write this script
ever performs is a reversible soft-delete (deleted=1) of a duplicate row that has zero
associated orders, and only when DRY_RUN is explicitly set to false.

Run on a schedule. Safe to run again and again.
"""
import os
import logging
from collections import defaultdict
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_duplicate_customers")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "200"))
AUTH = (PRESTASHOP_WS_KEY, "")


def normalize_email(email):
    return str(email or "").strip().lower()


def pick_merge_action(customer_rows):
    """Pure decision function, no I/O.

    customer_rows is a list of customer dicts (keys: id, email, is_guest, deleted,
    date_add, order_count) that all share one normalized email. Returns None if one or
    zero active (deleted=0) rows remain. Otherwise returns a dict with email, keep_id
    (the row with the highest order_count, ties broken by is_guest==False then earliest
    date_add), duplicate_ids (every other active row), and a human-readable reason.
    """
    active = [r for r in customer_rows if str(r.get("deleted", "0")) != "1"]
    if len(active) <= 1:
        return None

    def sort_key(row):
        order_count = row.get("order_count", 0) or 0
        is_guest = str(row.get("is_guest", "0")) == "1"
        is_registered = 0 if is_guest else 1  # non-guest sorts first (0)
        date_add = str(row.get("date_add") or "9999-99-99 99:99:99")
        return (-order_count, -is_registered, date_add)

    ranked = sorted(active, key=sort_key)
    keep = ranked[0]
    duplicates = ranked[1:]
    return {
        "email": customer_rows[0].get("email"),
        "keep_id": keep.get("id"),
        "duplicate_ids": [r.get("id") for r in duplicates],
        "reason": "highest order_count, then registered over guest, then earliest date_add",
    }


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def all_customers(page_size=PAGE_SIZE):
    offset = 0
    rows = []
    while True:
        data = api_get("customers", params={
            "display": "[id,email,is_guest,deleted,date_add]",
            "limit": f"{offset},{page_size}",
        })
        page = data.get("customers") or []
        rows.extend(page)
        if len(page) < page_size:
            return rows
        offset += page_size


def group_by_email(customers):
    groups = defaultdict(list)
    for c in customers:
        groups[normalize_email(c.get("email"))].append(c)
    return {email: rows for email, rows in groups.items() if len(rows) > 1}


def order_count_for(id_customer):
    data = api_get("orders", params={"filter[id_customer]": id_customer, "display": "full"})
    return len(data.get("orders") or [])


def soft_delete_customer(id_customer):
    data = api_get(f"customers/{id_customer}", params={"display": "full"})
    customer = data["customer"]
    customer["deleted"] = "1"
    r = requests.put(
        f"{PRESTASHOP_URL}/api/customers/{id_customer}",
        params={"output_format": "JSON"},
        json={"customer": customer},
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    customers = all_customers()
    duplicate_groups = group_by_email(customers)

    flagged = 0
    for email, rows in duplicate_groups.items():
        for row in rows:
            row["order_count"] = order_count_for(row["id"])

        action = pick_merge_action(rows)
        if action is None:
            continue

        flagged += 1
        log.warning(
            "Merge candidate found. email=%s keep_id=%s duplicate_ids=%s reason=%s",
            action["email"], action["keep_id"], action["duplicate_ids"], action["reason"],
        )

        if DRY_RUN:
            continue

        by_id = {r["id"]: r for r in rows}
        for dup_id in action["duplicate_ids"]:
            if by_id[dup_id].get("order_count", 0) == 0:
                log.warning("Soft-deleting zero-order duplicate id_customer=%s", dup_id)
                soft_delete_customer(dup_id)
            else:
                log.warning(
                    "Skipping soft-delete for id_customer=%s, it has order history. Manual merge required.",
                    dup_id,
                )

    log.info(
        "Done. %d email(s) with duplicate customer accounts flagged. DRY_RUN=%s "
        "(only zero-order duplicates are ever soft-deleted, never merged automatically).",
        flagged, DRY_RUN,
    )


if __name__ == "__main__":
    run()
