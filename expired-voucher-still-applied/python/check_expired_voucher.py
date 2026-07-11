"""Detect PrestaShop carts and orders still carrying an expired voucher.

CartRule::checkValidity() checks a voucher's date_to expiry differently depending on an
alreadyInCart flag. When a voucher is already sitting in the cart, that flag is true and
the expiry check is effectively bypassed, so a code added before its expiry date stays
valid through checkout even if the customer actually pays after date_to has passed.
Confirmed in PrestaShop/PrestaShop issues #26235 and #32303. Because the cart-to-order
conversion copies the cart_rule association into order_cart_rule at payment time without
re-validating dates, and nothing re-scans placed orders afterward, an expired discount
can ride all the way into a paid order, leaving the discount shown on the order out of
step with the amount actually charged, as reported in issue #34067 and the broader
"cart rules are a nest of cockroaches" bug collection in issue #28134.

This is a financial and discount-correctness issue, not a safely auto-correctable field,
so the default action is to flag every violation for manual finance or merchant review.
A DRY_RUN-guarded repair is available for still-open, unpaid carts only: PrestaShop's
webservice has no direct cart-cart_rule delete route, so the supported approach is a
full resource PUT to /api/carts/{id} with associations.cart_rules omitting the expired
id_cart_rule. Already-paid orders are never edited, since that would retroactively alter
invoiced totals.

Run on a schedule. Safe to run again and again.
"""
import os
import datetime
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_expired_voucher")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
OPEN_CART_IDS = [c for c in os.environ.get("OPEN_CART_IDS", "").split(",") if c]
AUTH = (PRESTASHOP_WS_KEY, "")


def is_voucher_expired_for_record(record_date, date_from, date_to, active):
    """Pure decision function, no I/O.

    record_date is order.date_add for a placed order, or cart.date_upd for a still-open
    cart. Returns True (flag as violation) when active is False and the association
    still exists, or when record_date falls outside [date_from, date_to], i.e.
    record_date > date_to or record_date < date_from. Returns False when record_date
    falls within the inclusive validity window and active is True.
    """
    if not active:
        return True
    if record_date > date_to:
        return True
    if record_date < date_from:
        return True
    return False


def build_cart_put_payload(cart, expired_id_cart_rule):
    """Build the full-resource PUT payload with the expired rule omitted.

    Never called against a paid order. Only for a still-open cart, and only ever
    logged, not sent, unless DRY_RUN is explicitly off.
    """
    cart = dict(cart)
    associations = dict(cart.get("associations") or {})
    rules = associations.get("cart_rules") or []
    kept = [r for r in rules if str(r.get("id")) != str(expired_id_cart_rule)]
    associations["cart_rules"] = kept
    cart["associations"] = associations
    return cart


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def api_put(path, payload):
    r = requests.put(
        f"{PRESTASHOP_URL}/api/{path}",
        params={"output_format": "JSON"},
        json=payload,
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def open_carts(cart_ids):
    if not cart_ids:
        return []
    ids = ",".join(str(i) for i in cart_ids)
    data = api_get("carts", params={"filter[id]": f"[{ids}]", "display": "full"})
    return data.get("carts") or []


def recent_orders():
    data = api_get("orders", params={"display": "full"})
    return data.get("orders") or []


def order_cart_rules_for(id_order):
    data = api_get("order_cart_rules", params={"filter[id_order]": id_order, "display": "full"})
    return data.get("order_cart_rules") or []


def cart_rule_detail(id_cart_rule):
    data = api_get(f"cart_rules/{id_cart_rule}")
    return data.get("cart_rule") or {}


def _to_epoch(value):
    return datetime.datetime.fromisoformat(str(value).replace(" ", "T")).timestamp()


def scan_orders():
    flagged = []
    for order in recent_orders():
        id_order = order["id"]
        order_date = order.get("date_add")
        if not order_date:
            continue
        for link in order_cart_rules_for(id_order):
            if str(link.get("deleted")) not in ("0", "False", "false"):
                continue
            rule = cart_rule_detail(link["id_cart_rule"])
            if not rule:
                continue
            violation = is_voucher_expired_for_record(
                _to_epoch(order_date),
                _to_epoch(rule["date_from"]),
                _to_epoch(rule["date_to"]),
                str(rule.get("active")) in ("1", "True", "true"),
            )
            if violation:
                flagged.append({
                    "id_order": id_order,
                    "id_cart_rule": link["id_cart_rule"],
                    "voucher_code": rule.get("code"),
                    "date_to": rule.get("date_to"),
                    "record_date": order_date,
                    "discount_value": link.get("value"),
                })
    return flagged


def scan_open_carts():
    flagged = []
    for cart in open_carts(OPEN_CART_IDS):
        cart_date = cart.get("date_upd")
        if not cart_date:
            continue
        rules = ((cart.get("associations") or {}).get("cart_rules")) or []
        for link in rules:
            rule = cart_rule_detail(link["id"])
            if not rule:
                continue
            violation = is_voucher_expired_for_record(
                _to_epoch(cart_date),
                _to_epoch(rule["date_from"]),
                _to_epoch(rule["date_to"]),
                str(rule.get("active")) in ("1", "True", "true"),
            )
            if violation:
                flagged.append({
                    "id_cart": cart["id"],
                    "id_cart_rule": link["id"],
                    "voucher_code": rule.get("code"),
                    "date_to": rule.get("date_to"),
                    "record_date": cart_date,
                    "cart": cart,
                })
    return flagged


def repair_open_cart(row):
    payload = build_cart_put_payload(row["cart"], row["id_cart_rule"])
    log.info(
        "%s cart %s: would PUT associations.cart_rules without id_cart_rule=%s",
        "DRY RUN" if DRY_RUN else "REPAIRING",
        row["id_cart"], row["id_cart_rule"],
    )
    if not DRY_RUN:
        api_put(f"carts/{row['id_cart']}", payload)


def run():
    order_violations = scan_orders()
    for row in order_violations:
        log.warning(
            "Expired voucher on PAID order (report only). id_order=%s id_cart_rule=%s "
            "code=%s date_to=%s order_date=%s discount_value=%s",
            row["id_order"], row["id_cart_rule"], row["voucher_code"],
            row["date_to"], row["record_date"], row["discount_value"],
        )

    cart_violations = scan_open_carts()
    for row in cart_violations:
        log.warning(
            "Expired voucher on OPEN cart. id_cart=%s id_cart_rule=%s code=%s "
            "date_to=%s cart_date=%s",
            row["id_cart"], row["id_cart_rule"], row["voucher_code"],
            row["date_to"], row["record_date"],
        )
        if OPEN_CART_IDS:
            repair_open_cart(row)

    log.info(
        "Done. %d paid order violation(s) flagged for finance review, %d open cart "
        "violation(s) found (%s).",
        len(order_violations), len(cart_violations),
        "would repair" if DRY_RUN else "repaired" if OPEN_CART_IDS else "report only",
    )


if __name__ == "__main__":
    run()
