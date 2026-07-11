"""Detect PrestaShop order lines where a partial refund exceeds the line's own total.

PrestaShop's partial-refund flow, whether through the back office Order Refund form, the
actionOrderSlipAdd hook, or a direct write through the webservice, computes the refunded
amount from whatever the operator or API caller submits. There is no consistent
server-side cap comparing that number against the order line's own product_quantity and
total_price_tax_incl, so a client that skips the back-office form can post a refund that
exceeds the line total with no rejection. The confirmed side effect is that
product_quantity_refunded can exceed product_quantity, since PrestaShop does not
recompute or cap product_quantity against refunds already issued.

This script only ever reports. It never mutates an order_detail row or an order_slip,
because a refund is a financial transaction already reflected in a credit note and
possibly reconciled with a payment gateway. The only corrective code here is a preventive
guard meant to be called before a NEW refund is created, not a repair of history.

Guide: https://www.allanninal.dev/prestashop/refund-amount-exceeds-line-total/

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_refund_overage")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
ORDER_ID_RANGE = os.environ.get("ORDER_ID_RANGE", "1,50")
AUTH = (PRESTASHOP_WS_KEY, "")

EPSILON = 0.01


def is_refund_overage(product_quantity, product_quantity_refunded, line_total_tax_incl,
                       refunded_amount_tax_incl, epsilon=EPSILON):
    """Pure decision logic, no I/O.

    Compares the refunded quantity and amount against the order line's own quantity and
    total, and returns a dict describing whether either one overshoots, and by how much.
    Caller supplies all values already fetched from the API.

    Returns {"overage": bool, "quantity_overage": int, "amount_overage": float}.
    """
    quantity_overage = max(0, product_quantity_refunded - product_quantity)
    raw_amount_overage = round(refunded_amount_tax_incl - line_total_tax_incl, 2)
    amount_overage = raw_amount_overage if raw_amount_overage > epsilon else 0.0
    overage = (quantity_overage > 0) or (amount_overage > epsilon)
    return {
        "overage": overage,
        "quantity_overage": quantity_overage,
        "amount_overage": amount_overage,
    }


def would_new_refund_overshoot(product_quantity, product_quantity_refunded,
                                line_total_tax_incl, already_refunded_tax_incl,
                                requested_quantity, requested_amount_tax_incl):
    """Preventive guard for a NEW refund request, before it is ever sent.

    Rejects when the requested quantity or amount would exceed the line's remaining
    unrefunded balance. This never touches a refund that already happened, it only stops
    the next one from repeating the mistake.
    """
    remaining_quantity = product_quantity - product_quantity_refunded
    remaining_amount = round(line_total_tax_incl - already_refunded_tax_incl, 2)
    return requested_quantity > remaining_quantity or requested_amount_tax_incl > remaining_amount + EPSILON


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


def refunded_amount_for_row(row):
    qty_refunded = int(row.get("product_quantity_refunded") or 0)
    unit_price = float(row.get("unit_price_tax_incl") or 0)
    return round(qty_refunded * unit_price, 2)


def run():
    flagged = 0
    for order in orders_in_range(ORDER_ID_RANGE):
        id_order = order["id"]
        for row in order_detail_rows(id_order):
            product_quantity = int(row.get("product_quantity") or 0)
            product_quantity_refunded = int(row.get("product_quantity_refunded") or 0)
            line_total_tax_incl = float(row.get("total_price_tax_incl") or 0)
            refunded_amount = refunded_amount_for_row(row)
            result = is_refund_overage(product_quantity, product_quantity_refunded,
                                        line_total_tax_incl, refunded_amount)
            if not result["overage"]:
                continue
            flagged += 1
            log.warning(
                "Refund overage. id_order=%s id_order_detail=%s product_quantity=%s "
                "product_quantity_refunded=%s total_price_tax_incl=%.2f refunded_amount=%.2f "
                "quantity_overage=%s amount_overage=%.2f",
                id_order, row.get("id"), product_quantity, product_quantity_refunded,
                line_total_tax_incl, refunded_amount,
                result["quantity_overage"], result["amount_overage"],
            )
    log.info("Done. %d line(s) flagged for review. DRY_RUN=%s (report only, no writes).", flagged, DRY_RUN)


if __name__ == "__main__":
    run()
