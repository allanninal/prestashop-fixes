"""Detect PrestaShop orders whose total went stale after a product line was
cancelled while a voucher was attached.

Cancelling a product from an order in Back Office > Orders (OrderController /
the Order class) recalculates the remaining order_detail line totals, but it
does not re-derive total_discounts from the cart rules still attached to the
order (order_cart_rules). A cart rule computed as a percent-of-total, a fixed
amount, or free shipping was calculated once against the cart as it stood at
checkout, so once a line is cancelled that original cart total no longer
exists and the stored discount goes stale, along with total_paid and
total_paid_tax_incl. Tracked upstream across PrestaShop/PrestaShop issues
#17347, #23358, #23038, #28134, with the invalid-discount shape (negative or
tax_excl greater than tax_incl) tracked separately as issue #11059.

This script defaults to detect and report only, since an order's total may
already be referenced by an invoice or an accounting export. The corrective
PUT to orders only runs under an explicit DRY_RUN=false override, always
prints a before/after diff, and never touches current_state (order state
changes belong only to POST /api/order_histories).

Run on a schedule for orders touched since the last run. Safe to run again
and again in report mode.
"""
import os
import logging
from decimal import Decimal

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_order_total_after_cancel")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
ORDER_IDS = [o.strip() for o in os.environ.get("ORDER_IDS", "").split(",") if o.strip()]
AUTH = (PRESTASHOP_WS_KEY, "")

TOLERANCE = Decimal("0.02")


def recompute_order_total(order_details, order_cart_rules, total_shipping,
                           reported_total_tax_incl, tolerance=TOLERANCE):
    """Pure decision function, no I/O.

    order_details is the list of order_details rows still present on the
    order (already fetched by the caller). order_cart_rules is the list of
    order_cart_rules rows for the order (already fetched). total_shipping and
    reported_total_tax_incl are plain values already read from the order.
    Returns the expected total, the delta against what the order reports,
    whether that delta exceeds tolerance, and whether the cart rule values
    have the invalid shape from issue #11059 (negative, or tax_excl sum
    greater than the tax_incl sum).
    """
    lines_sum = sum(
        (Decimal(str(d["total_price_tax_incl"])) for d in order_details),
        Decimal("0"),
    )
    active_rules = [r for r in order_cart_rules if str(r.get("deleted", "0")) == "0"]
    cart_rules_sum = sum(
        (Decimal(str(r["value"])) for r in active_rules),
        Decimal("0"),
    )
    expected = lines_sum + Decimal(str(total_shipping)) - cart_rules_sum
    reported = Decimal(str(reported_total_tax_incl))
    delta = reported - expected

    invalid_shape = any(Decimal(str(r["value"])) < 0 for r in active_rules)
    tax_excl_sum = sum(
        (Decimal(str(r.get("value_tax_excl", r["value"]))) for r in active_rules),
        Decimal("0"),
    )
    if tax_excl_sum > cart_rules_sum:
        invalid_shape = True

    return {
        "expected_total": expected,
        "reported_total": reported,
        "delta": delta,
        "is_mismatched": abs(delta) > tolerance,
        "invalid_discount_shape": invalid_shape,
    }


def build_report_row(id_order, result, active_rule_ids):
    return {
        "id_order": id_order,
        "expected_total": round(float(result["expected_total"]), 2),
        "reported_total": round(float(result["reported_total"]), 2),
        "delta": round(float(result["delta"]), 2),
        "is_mismatched": result["is_mismatched"],
        "invalid_discount_shape": result["invalid_discount_shape"],
        "order_cart_rules_summed": active_rule_ids,
    }


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def get_order(id_order):
    data = api_get(f"orders/{id_order}")
    return data.get("order") or {}


def order_details_for(id_order):
    data = api_get("order_details", params={
        "filter[id_order]": id_order,
        "display": "full",
    })
    return data.get("order_details") or []


def order_cart_rules_for(id_order):
    data = api_get("order_cart_rules", params={
        "filter[id_order]": id_order,
        "display": "full",
    })
    return data.get("order_cart_rules") or []


def apply_correction(id_order, order, result, active_rules):
    """Only called when DRY_RUN is explicitly false. Sends the full order
    body back with corrected discount and paid totals. Never touches
    current_state; state changes go only through POST /api/order_histories.
    """
    corrected = dict(order)
    cart_rules_sum = sum(Decimal(str(r["value"])) for r in active_rules) if active_rules else Decimal("0")
    tax_excl_sum = sum(
        Decimal(str(r.get("value_tax_excl", r["value"]))) for r in active_rules
    ) if active_rules else Decimal("0")
    corrected["total_discounts"] = str(cart_rules_sum)
    corrected["total_discounts_tax_incl"] = str(cart_rules_sum)
    corrected["total_discounts_tax_excl"] = str(tax_excl_sum)
    corrected["total_paid"] = str(result["expected_total"])
    corrected["total_paid_tax_incl"] = str(result["expected_total"])
    corrected["total_paid_tax_excl"] = str(result["expected_total"] - (cart_rules_sum - tax_excl_sum))
    corrected.pop("current_state", None)

    log.warning("BEFORE: total_paid_tax_incl=%s total_discounts=%s",
                order.get("total_paid_tax_incl"), order.get("total_discounts"))
    log.warning("AFTER:  total_paid_tax_incl=%s total_discounts=%s",
                corrected["total_paid_tax_incl"], corrected["total_discounts"])

    r = requests.put(
        f"{PRESTASHOP_URL}/api/orders/{id_order}",
        params={"output_format": "JSON"},
        json={"order": corrected},
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    if not ORDER_IDS:
        log.error("Set ORDER_IDS to a comma separated list of order ids to check.")
        return

    flagged = 0
    for id_order in ORDER_IDS:
        order = get_order(id_order)
        if not order:
            log.warning("Order %s not found, skipping.", id_order)
            continue
        details = order_details_for(id_order)
        cart_rules = order_cart_rules_for(id_order)
        active_rules = [r for r in cart_rules if str(r.get("deleted", "0")) == "0"]

        result = recompute_order_total(
            details, cart_rules, order.get("total_shipping", "0"),
            order.get("total_paid_tax_incl", "0"),
        )
        if not (result["is_mismatched"] or result["invalid_discount_shape"]):
            continue

        row = build_report_row(id_order, result, [r.get("id") for r in active_rules])
        flagged += 1
        log.warning(
            "Order %s total mismatch. expected=%.2f reported=%.2f delta=%.2f "
            "invalid_discount_shape=%s cart_rules=%s",
            row["id_order"], row["expected_total"], row["reported_total"],
            row["delta"], row["invalid_discount_shape"], row["order_cart_rules_summed"],
        )

        if not DRY_RUN:
            apply_correction(id_order, order, result, active_rules)
            log.info("Order %s corrected via PUT /api/orders/%s.", id_order, id_order)

    log.info(
        "Done. %d order(s) flagged. DRY_RUN=%s (repair only runs when explicitly false).",
        flagged, DRY_RUN,
    )


if __name__ == "__main__":
    run()
