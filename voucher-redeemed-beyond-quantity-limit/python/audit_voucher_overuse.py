"""Find PrestaShop single-use cart rules that were redeemed on more orders than their
quantity or quantity_per_user allows.

CartRule::checkValidity reads a voucher's remaining quantity and a customer's prior
quantity_per_user usage at apply time and again at order validation, but those reads
and writes are not wrapped in a locking transaction. Under concurrent checkouts, two
orders can each pass the check before either one's validation decrements the used
count, so a single-use voucher can end up referenced by more than one paid order.
quantity_per_user is also checked against id_customer, so guest checkouts can bypass
the per-user cap.

This script only reports. The optional, DRY_RUN-guarded corrective step only disables
further use of the voucher by setting quantity to 0; it never cancels, edits, or
refunds an order that already used it. Safe to run again and again.

Guide: https://www.allanninal.dev/prestashop/voucher-redeemed-beyond-quantity-limit/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("audit_voucher_overuse")

BASE_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
CART_RULE_ID = int(os.environ.get("CART_RULE_ID", "42"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

VALID_STATE_IDS = {2, 3, 4, 5}  # payment accepted, processing, shipped, delivered


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


def get_cart_rule(cart_rule_id):
    data = api_get(f"cart_rules/{cart_rule_id}")
    rule = data["cart_rule"]
    return {
        "id": int(rule["id"]),
        "code": rule.get("code") or "",
        "quantity": int(rule["quantity"]),
        "quantity_per_user": int(rule["quantity_per_user"]),
    }


def orders_using_rule(cart_rule_id):
    data = api_get("order_cart_rules", {"filter[id_cart_rule]": cart_rule_id, "display": "full"})
    links = data.get("order_cart_rules") or []
    rows = []
    for link in links:
        order_id = int(link["id_order"])
        order_data = api_get(f"orders/{order_id}", {"display": "full"})["order"]
        rows.append({
            "id_order": order_id,
            "id_customer": int(order_data["id_customer"]) if order_data.get("id_customer") else None,
            "current_state": int(order_data["current_state"]),
            "date_add": order_data["date_add"],
        })
    return [r for r in rows if r["current_state"] in VALID_STATE_IDS]


def find_voucher_overuse(cart_rule, orders_using_rule_list):
    """
    cart_rule: {"id": int, "code": str, "quantity": int, "quantity_per_user": int}
    orders_using_rule_list: [{"id_order": int, "id_customer": int|None, "current_state": int,
      "date_add": str}, ...] pre-filtered to only orders whose state is a "valid"
      (paid/processing/shipped) order_state.

    Returns None if no overage, else {"cart_rule_id", "code", "quantity_limit",
      "total_uses", "overage_count", "offending_order_ids", "per_user_violations":
      {id_customer: count}}.

    Decision logic: count total valid orders referencing the rule vs cart_rule['quantity'];
    group by id_customer and compare each group's count vs quantity_per_user; flag if
    either cap is exceeded.
    """
    total_uses = len(orders_using_rule_list)
    per_user_counts = {}
    for order in orders_using_rule_list:
        cust = order.get("id_customer")
        per_user_counts[cust] = per_user_counts.get(cust, 0) + 1

    per_user_violations = {
        cust: count for cust, count in per_user_counts.items()
        if count > cart_rule["quantity_per_user"]
    }

    total_overage = total_uses > cart_rule["quantity"]
    if not total_overage and not per_user_violations:
        return None

    offending_ids = sorted(o["id_order"] for o in orders_using_rule_list)
    return {
        "cart_rule_id": cart_rule["id"],
        "code": cart_rule["code"],
        "quantity_limit": cart_rule["quantity"],
        "total_uses": total_uses,
        "overage_count": max(0, total_uses - cart_rule["quantity"]),
        "offending_order_ids": offending_ids,
        "per_user_violations": per_user_violations,
    }


def disable_further_use(cart_rule_id):
    body = {"cart_rule": {"id": cart_rule_id, "quantity": 0}}
    if DRY_RUN:
        log.info("Dry run: would PUT cart_rules/%s %s", cart_rule_id, body)
        return None
    return api_put(f"cart_rules/{cart_rule_id}", body)


def run():
    cart_rule = get_cart_rule(CART_RULE_ID)
    valid_orders = orders_using_rule(CART_RULE_ID)

    report = find_voucher_overuse(cart_rule, valid_orders)
    if report is None:
        log.info("Cart rule %s (%s) is within its quantity and quantity_per_user limits.",
                  cart_rule["id"], cart_rule["code"])
        return

    log.warning("Voucher overuse detected: %s", report)
    disable_further_use(CART_RULE_ID)
    log.info("Done. Report ready for manual review.")


if __name__ == "__main__":
    run()
