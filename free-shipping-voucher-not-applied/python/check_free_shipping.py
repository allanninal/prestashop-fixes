"""Detect PrestaShop orders where a free shipping voucher applied but shipping stayed nonzero.

PrestaShop stores a cart rule's free shipping benefit as a boolean flag, free_shipping,
on cart_rule and cart_rule_action. That flag only turns into an actual zero shipping
cost when the normal cart totals pipeline, Cart::getTotalShippingCost and
getPackageShippingCost, runs and the rule passes every restriction check: carrier
restriction, minimum amount, product or category or group scoping, and combinability
with other applied rules. If the voucher is combined with a non-combinable rule, the
carrier is not in the allowed list, or the order was written through the webservice, a
bulk import, a POS sync, or a custom checkout instead of Cart totals recalculation, the
flag never reaches total_shipping and total_shipping_tax_incl, and the carrier's full
cost stays on the order. Confirmed as a display and calculation bug in
PrestaShop/PrestaShop issues #18533 and #17489, and reported repeatedly on the
PrestaShop community forums.

Recomputing order totals has to reuse PrestaShop's own tax and shipping rules, not a
script blindly zeroing a field, so the default action is to flag every violation for
manual review or a back office recalculation. A DRY_RUN-guarded write is available only
when explicitly authorized, after confirming through order_carriers and
order_cart_rules that the rule was genuinely valid for the order's carrier.

Guide: https://www.allanninal.dev/prestashop/free-shipping-voucher-not-applied/

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests
from decimal import Decimal

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_free_shipping")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
ORDER_IDS = [o for o in os.environ.get("ORDER_IDS", "").split(",") if o]
AUTH = (PRESTASHOP_WS_KEY, "")


def decide_free_shipping_violation(cart_rule, order, order_carrier):
    """Pure decision function, no I/O.

    Given a cart_rule dict (fields: free_shipping, active, carrier_restriction,
    minimum_amount, date_from, date_to), an order dict (fields:
    total_shipping_tax_incl, total_paid_tax_incl, id_carrier, date_add), and the
    order_carrier dict (fields: id_carrier, shipping_cost_tax_incl), returns True (flag
    as violation) iff: cart_rule['active'] is truthy AND cart_rule['free_shipping'] is
    truthy AND the order date falls within [date_from, date_to] AND (not
    cart_rule['carrier_restriction'] or the order's id_carrier is in the rule's allowed
    carrier set) AND Decimal(order['total_shipping_tax_incl']) > Decimal('0.00').
    Returns False otherwise, including when carrier_restriction correctly excludes this
    carrier.
    """
    if not cart_rule.get("active"):
        return False
    if not cart_rule.get("free_shipping"):
        return False

    order_date = order.get("date_add")
    if not order_date:
        return False
    if not (cart_rule.get("date_from") <= order_date <= cart_rule.get("date_to")):
        return False

    restriction = cart_rule.get("carrier_restriction")
    if restriction:
        allowed_carriers = restriction if isinstance(restriction, (list, set, tuple)) else [restriction]
        if order.get("id_carrier") not in allowed_carriers:
            return False

    return Decimal(str(order.get("total_shipping_tax_incl", "0"))) > Decimal("0.00")


def build_zero_shipping_payload(order):
    """Build the order payload with shipping zeroed and total_paid adjusted.

    Only ever logged, not sent, unless DRY_RUN is explicitly off and the free shipping
    rule has already been confirmed valid for this order's carrier.
    """
    order = dict(order)
    shipping_incl = Decimal(str(order.get("total_shipping_tax_incl", "0")))
    total_paid_incl = Decimal(str(order.get("total_paid_tax_incl", "0"))) - shipping_incl
    total_paid = Decimal(str(order.get("total_paid", "0"))) - shipping_incl

    order["total_shipping"] = "0.00"
    order["total_shipping_tax_incl"] = "0.00"
    order["total_shipping_tax_excl"] = "0.00"
    order["total_paid_tax_incl"] = str(total_paid_incl)
    order["total_paid"] = str(total_paid)
    return order


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


def free_shipping_rules():
    data = api_get("cart_rules", params={
        "filter[free_shipping]": 1,
        "filter[active]": 1,
        "display": "full",
    })
    return data.get("cart_rules") or []


def order_detail(id_order):
    data = api_get(f"orders/{id_order}", params={"display": "full"})
    return data.get("order") or {}


def order_cart_rules_for(id_order):
    data = api_get("order_cart_rules", params={"filter[id_order]": id_order, "display": "full"})
    return data.get("order_cart_rules") or []


def scan_orders(order_ids):
    rules_by_id = {str(r["id"]): r for r in free_shipping_rules()}
    flagged = []
    for id_order in order_ids:
        order = order_detail(id_order)
        if not order:
            continue
        for link in order_cart_rules_for(id_order):
            rule = rules_by_id.get(str(link.get("id_cart_rule")))
            if not rule:
                continue
            violation = decide_free_shipping_violation(rule, order, {})
            if violation:
                flagged.append({
                    "id_order": id_order,
                    "id_cart_rule": rule["id"],
                    "voucher_code": rule.get("code"),
                    "id_carrier": order.get("id_carrier"),
                    "total_shipping_tax_incl": order.get("total_shipping_tax_incl"),
                    "total_shipping_tax_excl": order.get("total_shipping_tax_excl"),
                    "order": order,
                })
    return flagged


def repair_order(row):
    payload = build_zero_shipping_payload(row["order"])
    log.info(
        "%s order %s: would set total_shipping_tax_incl from %s to 0.00 (voucher %s)",
        "DRY RUN" if DRY_RUN else "REPAIRING",
        row["id_order"], row["total_shipping_tax_incl"], row["voucher_code"],
    )
    if not DRY_RUN:
        api_put(f"orders/{row['id_order']}", payload)


def run():
    violations = scan_orders(ORDER_IDS)
    for row in violations:
        log.warning(
            "Free shipping voucher not applied. id_order=%s code=%s id_carrier=%s "
            "total_shipping_tax_incl=%s total_shipping_tax_excl=%s",
            row["id_order"], row["voucher_code"], row["id_carrier"],
            row["total_shipping_tax_incl"], row["total_shipping_tax_excl"],
        )
        repair_order(row)

    log.info(
        "Done. %d order(s) with an unapplied free shipping voucher %s.",
        len(violations), "would be fixed" if DRY_RUN else "fixed",
    )


if __name__ == "__main__":
    run()
