"""Detect PrestaShop invoice numbers issued to more than one order.

Order::setInvoice() and setLastInvoiceNumber() compute the next invoice number with a
query equivalent to SELECT MAX(number)+1 FROM ps_order_invoice, then write that value
into the new invoice row as a separate step. Nothing serializes the read and the write:
there is no auto-increment column backing number, and no SELECT ... FOR UPDATE inside a
transaction. Under concurrent checkout load, two order-validation requests can both read
the same current MAX before either has written its own row, so both persist the
identical number for two different orders. Tracked upstream in PrestaShop/PrestaShop
issues #28757, #23025, and #12660, reported against nearly every version from 1.6
through 1.7.8.x and later, and unresolved in core.

This script only reads and reports. Invoice numbers are fiscal and legal documents in
most jurisdictions, so renumbering an already-issued invoice automatically is unsafe.
Flagged pairs need a human, an accountant or admin, to decide which order keeps the
number and which one gets a corrective reissued invoice through the normal Back Office
generate invoice action. Never PUT or PATCH order_invoices to change number directly.

Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/prestashop/duplicate-invoice-numbers/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_duplicate_invoice_numbers")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
DATE_START = os.environ.get("INVOICE_DATE_START", "")
DATE_END = os.environ.get("INVOICE_DATE_END", "")
AUTH = (PRESTASHOP_WS_KEY, "")


def find_duplicate_invoice_numbers(invoices):
    """Pure decision function, no I/O.

    invoices is a list of order_invoices rows already fetched, each with at least id,
    id_order, number, and date_add. Groups the rows by number and returns a collision
    dict for every number whose rows span more than one distinct id_order:
        {"number": ..., "orders": [id_order, ...], "invoice_ids": [id, ...],
         "timestamps": [date_add, ...]}
    A single order fetched twice keeps the same id_order both times, so it is never
    counted as a collision.
    """
    groups = {}
    for inv in invoices:
        groups.setdefault(inv["number"], []).append(inv)

    collisions = []
    for number, rows in groups.items():
        distinct_orders = {r["id_order"] for r in rows}
        if len(distinct_orders) > 1:
            collisions.append({
                "number": number,
                "orders": [r["id_order"] for r in rows],
                "invoice_ids": [r["id"] for r in rows],
                "timestamps": [r["date_add"] for r in rows],
            })
    return collisions


def build_report_row(collision):
    orders = collision["orders"]
    timestamps = collision["timestamps"]
    return {
        "number": collision["number"],
        "id_order_a": orders[0],
        "id_order_b": orders[1],
        "invoice_ids": collision["invoice_ids"],
        "date_add_a": timestamps[0],
        "date_add_b": timestamps[1],
    }


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def recent_invoices(date_start, date_end):
    data = api_get("order_invoices", params={
        "filter[date_add]": f"[{date_start},{date_end}]",
        "display": "full",
    })
    return data.get("order_invoices") or []


def orders_by_ids(id_order_a, id_order_b):
    data = api_get("orders", params={
        "filter[id]": f"[{id_order_a}|{id_order_b}]",
        "display": "full",
    })
    return data.get("orders") or []


def confirm_orders_differ(id_order_a, id_order_b):
    orders = {str(o["id"]): o for o in orders_by_ids(id_order_a, id_order_b)}
    a = orders.get(str(id_order_a))
    b = orders.get(str(id_order_b))
    if not a or not b:
        return False
    return a.get("id_customer") != b.get("id_customer") or a.get("reference") != b.get("reference")


def run():
    if not DATE_START or not DATE_END:
        log.error("Set INVOICE_DATE_START and INVOICE_DATE_END (YYYY-MM-DD) to the window to scan.")
        return

    invoices = recent_invoices(DATE_START, DATE_END)
    collisions = find_duplicate_invoice_numbers(invoices)

    flagged = 0
    for collision in collisions:
        id_order_a, id_order_b = collision["orders"][0], collision["orders"][1]
        if not confirm_orders_differ(id_order_a, id_order_b):
            continue
        row = build_report_row(collision)
        flagged += 1
        log.warning(
            "Duplicate invoice number found. number=%s id_order_a=%s id_order_b=%s "
            "invoice_ids=%s date_add_a=%s date_add_b=%s",
            row["number"], row["id_order_a"], row["id_order_b"],
            row["invoice_ids"], row["date_add_a"], row["date_add_b"],
        )
    log.info(
        "Done. %d duplicate invoice number(s) flagged for manual review. DRY_RUN=%s "
        "(no writes are ever performed, invoice numbers are never changed automatically).",
        flagged, DRY_RUN,
    )


if __name__ == "__main__":
    run()
