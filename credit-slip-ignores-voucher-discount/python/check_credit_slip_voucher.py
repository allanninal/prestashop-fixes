"""Detect PrestaShop credit slips that ignored the order's own voucher discount.

A voucher, or cart rule, reduces an order's total order-wide and is stored in
order_cart_rules, linked to id_order, not to any single order_detail line. When a refund
creates an order_slip, PrestaShop's core refund computation, and separately the PDF or
HTML credit slip template, can each total the refund from a line's gross
unit_price_tax_incl instead of the net amount the customer actually paid after the
voucher. The result is a credit slip whose total_products_tax_incl or amount is bigger
than it should be, effectively handing the voucher discount back as extra refund. This is
a long-standing, repeatedly reported defect (GitHub #18319, #19214, #28284, #34958)
rather than a one-off bug, and different refund paths have each been found to skip the
voucher reduction differently, so a generic patch should not be assumed present in any
given store's PrestaShop version.

This script only ever reports. It never mutates an order_slip, because a credit slip is
an accounting and legal document, often already reflected in an exported invoice, a
posted accounting entry, or a refund that already left the bank. Every flagged order is a
lead for accounting staff to correct by hand through Orders, Credit Slips in the back
office.

Run on a schedule. Safe to run again and again.
"""
import os
import logging
from decimal import Decimal, ROUND_HALF_UP

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_credit_slip_voucher")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
ORDER_ID_RANGE = os.environ.get("ORDER_ID_RANGE", "1,50")
AUTH = (PRESTASHOP_WS_KEY, "")

TOLERANCE = Decimal("0.02")


def _d(value):
    return Decimal(str(value if value is not None else 0))


def expected_refund_amount(line_items, voucher_total_tax_incl, products_total_before_discount_tax_incl,
                            shipping_refund_tax_incl=Decimal("0")):
    """Pure decision logic, no I/O.

    Prorates each refunded line by its own qty_refunded / qty_ordered, sums those into a
    gross refund, then applies the order-level discount_ratio derived from the voucher
    total before adding back any refunded shipping. Caller supplies all values already
    fetched from the API.

    line_items: list of {"qty_refunded": int, "qty_ordered": int, "line_total_tax_incl": Decimal}
    """
    if products_total_before_discount_tax_incl:
        discount_ratio = voucher_total_tax_incl / products_total_before_discount_tax_incl
    else:
        discount_ratio = Decimal("0")

    gross_refund = Decimal("0")
    for line in line_items:
        qty_ordered = line["qty_ordered"]
        if qty_ordered > 0:
            prorated = line["line_total_tax_incl"] * (Decimal(line["qty_refunded"]) / Decimal(qty_ordered))
        else:
            prorated = Decimal("0")
        gross_refund += prorated

    result = gross_refund * (Decimal("1") - discount_ratio) + shipping_refund_tax_incl
    return result.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def is_slip_overstated(actual_slip_amount, expected_amount, tolerance=TOLERANCE):
    """Pure decision logic, no I/O. True when the recorded credit slip amount exceeds
    the expected refund by more than the rounding tolerance."""
    return (actual_slip_amount - expected_amount) > tolerance


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def orders_in_range(id_range):
    data = api_get("orders", params={"filter[id]": f"[{id_range}]", "display": "full"})
    return data.get("orders") or []


def order_detail_rows(id_order):
    data = api_get("order_details", params={"filter[id_order]": id_order, "display": "full"})
    return data.get("order_details") or []


def order_cart_rules(id_order):
    data = api_get("order_cart_rules", params={"filter[id_order]": id_order, "display": "full"})
    return data.get("order_cart_rules") or []


def order_slips(id_order):
    data = api_get("order_slip", params={"filter[id_order]": id_order, "display": "full"})
    return data.get("order_slip") or []


def slip_amount(slip):
    products = _d(slip.get("total_products_tax_incl"))
    shipping = _d(slip.get("total_shipping_tax_incl"))
    amount = slip.get("amount")
    return _d(amount) if amount is not None else (products + shipping)


def run():
    flagged = 0
    for order in orders_in_range(ORDER_ID_RANGE):
        id_order = order["id"]
        rules = order_cart_rules(id_order)
        if not rules:
            continue  # no voucher on this order, nothing to check

        voucher_total = sum((_d(r.get("value_tax_incl") or r.get("value")) for r in rules), Decimal("0"))
        rows = order_detail_rows(id_order)

        products_total_before_discount = sum((_d(row.get("total_price_tax_incl")) for row in rows), Decimal("0"))
        line_items = [
            {
                "qty_ordered": int(row.get("product_quantity") or 0),
                "qty_refunded": int(row.get("product_quantity_refunded") or 0),
                "line_total_tax_incl": _d(row.get("total_price_tax_incl")),
            }
            for row in rows
        ]

        expected = expected_refund_amount(line_items, voucher_total, products_total_before_discount)

        for slip in order_slips(id_order):
            actual = slip_amount(slip)
            if not is_slip_overstated(actual, expected):
                continue
            flagged += 1
            log.warning(
                "Credit slip overstated. id_order=%s id_order_slip=%s voucher_value_detected=%.2f "
                "expected_refund=%.2f actual_slip_amount=%.2f overstated_by=%.2f",
                id_order, slip.get("id"), voucher_total, expected, actual, actual - expected,
            )
    log.info("Done. %d order slip(s) flagged for review. DRY_RUN=%s (report only, no writes).", flagged, DRY_RUN)


if __name__ == "__main__":
    run()
