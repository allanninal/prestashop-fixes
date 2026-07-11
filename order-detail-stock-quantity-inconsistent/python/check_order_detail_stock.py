"""Detect PrestaShop order_detail rows where the stock snapshot disagrees with the order.

Every order_detail row carries product_quantity, what was actually ordered, and
product_quantity_in_stock, a snapshot computed separately at order-save time by
Product::getQuantity() and the stock logic, meant to record whether the item was in
stock when ordered. Because product_quantity_in_stock is computed rather than copied
from product_quantity, regressions in that computation (see PrestaShop GitHub issue
#16840) and edge cases like disabled stock management, advanced stock management,
backorders, or partial refunds can leave product_quantity_in_stock at 0 while
product_quantity still shows the real ordered amount on the same row.

This script never writes to order_details. product_quantity_in_stock is a historical
snapshot tied to real stock events at order time, so rewriting it automatically can
hide a genuine backorder or oversell event and corrupt the audit trail. It only detects
inconsistent rows and emits a report line for a human to review. A confirmed fix is a
targeted, manual PUT to order_details/{id} correcting product_quantity_in_stock alone,
never a bulk automated write.

Guide: https://www.allanninal.dev/prestashop/order-detail-stock-quantity-inconsistent/

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_order_detail_stock")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
PRESTASHOP_WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
ORDER_DATE_FROM = os.environ.get("ORDER_DATE_FROM", "")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def is_stock_quantity_inconsistent(product_quantity, product_quantity_in_stock, product_quantity_refunded=0):
    """Pure decision function, no I/O.

    Returns True when product_quantity is positive and product_quantity_in_stock does
    not equal product_quantity minus product_quantity_refunded, i.e. the in-stock
    snapshot disagrees with the net ordered quantity for that line.
    """
    if product_quantity <= 0:
        return False
    return product_quantity_in_stock != (product_quantity - product_quantity_refunded)


def build_report_row(order_detail, id_order):
    return {
        "id_order": id_order,
        "id_order_detail": order_detail["id"],
        "product_id": order_detail.get("product_id"),
        "product_quantity": int(order_detail.get("product_quantity", 0)),
        "product_quantity_in_stock": int(order_detail.get("product_quantity_in_stock", 0)),
    }


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def recent_order_ids(date_from):
    params = {"display": "full"}
    if date_from:
        params["filter[date_add]"] = f"{date_from},"
    data = api_get("orders", params=params)
    orders = data.get("orders") or []
    return [o["id"] for o in orders]


def order_detail_lines(id_order):
    data = api_get("order_details", params={"filter[id_order]": id_order, "display": "full"})
    return data.get("order_details") or []


def run(date_from=None):
    date_from = date_from if date_from is not None else ORDER_DATE_FROM
    flagged = 0
    for id_order in recent_order_ids(date_from):
        for line in order_detail_lines(id_order):
            product_quantity = int(line.get("product_quantity", 0))
            product_quantity_in_stock = int(line.get("product_quantity_in_stock", 0))
            product_quantity_refunded = int(line.get("product_quantity_refunded", 0))
            if not is_stock_quantity_inconsistent(product_quantity, product_quantity_in_stock, product_quantity_refunded):
                continue
            row = build_report_row(line, id_order)
            flagged += 1
            log.warning(
                "Inconsistent order_detail. id_order=%s id_order_detail=%s product_id=%s "
                "product_quantity=%s product_quantity_in_stock=%s product_quantity_refunded=%s",
                row["id_order"], row["id_order_detail"], row["product_id"],
                row["product_quantity"], row["product_quantity_in_stock"], product_quantity_refunded,
            )
    log.info(
        "Done. %d order_detail row(s) flagged for review. DRY_RUN=%s (this script never writes to order_details).",
        flagged, DRY_RUN,
    )


if __name__ == "__main__":
    run()
