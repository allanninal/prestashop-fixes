"""Find PrestaShop "one use per customer" cart rules that a guest checkout redeemed
more than once under the same email address.

CartRule::checkValidity enforces quantity_per_user by counting prior orders against
id_customer. Guest checkout never reuses or merges an existing account by email:
every guest order creates a brand new customer record, and therefore a brand new
id_customer, even when the same email is entered again. Because that fresh
id_customer always shows zero prior uses, quantity_per_user=1 never blocks a repeat
guest order under the same email (PrestaShop/PrestaShop #10122, #16370).

This script only reports. The optional, DRY_RUN-guarded corrective step only disables
further redemptions of the voucher by setting active=0; it never cancels, edits, or
refunds an order that already redeemed it. Safe to run again and again.

Guide: https://www.allanninal.dev/prestashop/voucher-per-user-limit-ignored-for-guests/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("audit_guest_voucher_reuse")

BASE_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ERROR_STATE_IDS = {6, 8}  # PS_OS_ERROR, PS_OS_CANCELED (adjust to your store's order_states)


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{BASE_URL}/api/{path}", params=params, auth=(WS_KEY, ""), timeout=30)
    r.raise_for_status()
    return r.json()


def api_put(path, body):
    r = requests.put(
        f"{BASE_URL}/api/{path}",
        params={"output_format": "JSON"},
        json=body,
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def limited_cart_rules():
    data = api_get("cart_rules", {"filter[quantity_per_user]": 1, "display": "full"})
    rules = data.get("cart_rules") or []
    return [
        {
            "id": int(r["id"]),
            "code": r.get("code") or "",
            "quantity_per_user": int(r["quantity_per_user"]),
            "quantity": int(r["quantity"]),
        }
        for r in rules
    ]


def order_cart_rule_links(cart_rule_id):
    data = api_get("order_cart_rules", {"filter[id_cart_rule]": cart_rule_id, "display": "full"})
    links = data.get("order_cart_rules") or []
    return [{"id_cart_rule": cart_rule_id, "id_order": int(link["id_order"])} for link in links]


def get_order(order_id):
    o = api_get(f"orders/{order_id}")["order"]
    return {
        "id": int(o["id"]),
        "id_customer": int(o["id_customer"]) if o.get("id_customer") else None,
        "current_state": int(o["current_state"]),
    }


def get_customer(customer_id):
    c = api_get(f"customers/{customer_id}")["customer"]
    return {"id": int(c["id"]), "email": c.get("email") or ""}


def find_overused_vouchers(cart_rules, order_cart_rules, orders, customers):
    """Pure decision logic, no I/O.

    Groups redemptions by (id_cart_rule, email) instead of (id_cart_rule, id_customer),
    so a guest who checks out repeatedly under the same email with a fresh id_customer
    each time is still recognized as the same person. Returns a list of entries for any
    (id_cart_rule, email) pair whose redemption count exceeds quantity_per_user.
    """
    rules_by_id = {int(r["id"]): r for r in cart_rules}
    email_by_customer = {int(c["id"]): (c.get("email") or "") for c in customers}

    customer_by_order = {}
    for o in orders:
        if int(o["current_state"]) in ERROR_STATE_IDS:
            continue
        if o.get("id_customer"):
            customer_by_order[int(o["id"])] = int(o["id_customer"])

    counts = {}  # (id_cart_rule, email) -> {"count": n, "id_orders": [...]}
    for link in order_cart_rules:
        id_cart_rule = int(link["id_cart_rule"])
        id_order = int(link["id_order"])
        id_customer = customer_by_order.get(id_order)
        if id_customer is None:
            continue  # order excluded (error/cancelled) or unknown
        email = email_by_customer.get(id_customer, "")
        key = (id_cart_rule, email)
        entry = counts.setdefault(key, {"count": 0, "id_orders": []})
        entry["count"] += 1
        entry["id_orders"].append(id_order)

    flagged = []
    for (id_cart_rule, email), entry in counts.items():
        rule = rules_by_id.get(id_cart_rule)
        if not rule:
            continue
        quantity_per_user = int(rule["quantity_per_user"])
        if entry["count"] > quantity_per_user:
            flagged.append({
                "id_cart_rule": id_cart_rule,
                "code": rule.get("code") or "",
                "email": email,
                "quantity_per_user": quantity_per_user,
                "actual_uses": entry["count"],
                "id_orders": sorted(entry["id_orders"]),
            })
    flagged.sort(key=lambda f: (f["id_cart_rule"], f["email"]))
    return flagged


def disable_further_use(cart_rule_id):
    body = {"cart_rule": {"id": cart_rule_id, "active": 0}}
    if DRY_RUN:
        log.info("Dry run: would PUT cart_rules/%s %s", cart_rule_id, body)
        return None
    return api_put(f"cart_rules/{cart_rule_id}", body)


def run():
    cart_rules = limited_cart_rules()

    all_links = []
    order_ids = set()
    for rule in cart_rules:
        links = order_cart_rule_links(rule["id"])
        all_links.extend(links)
        order_ids.update(link["id_order"] for link in links)

    orders = [get_order(order_id) for order_id in order_ids]
    customer_ids = {o["id_customer"] for o in orders if o["id_customer"]}
    customers = [get_customer(customer_id) for customer_id in customer_ids]

    report = find_overused_vouchers(cart_rules, all_links, orders, customers)
    if not report:
        log.info("No per-customer voucher overuse found across %d limited cart rule(s).", len(cart_rules))
        return

    for entry in report:
        log.warning("Voucher overuse detected: %s", entry)

    log.info("Done. %d overused voucher/email pair(s). Report ready for manual review.", len(report))


if __name__ == "__main__":
    run()
