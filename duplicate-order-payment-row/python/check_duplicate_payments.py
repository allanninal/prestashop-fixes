"""Detect PrestaShop orders with a duplicated order_payment row.

When an order state has both Consider the associated order as validated and Set the
order as paid enabled together, such as a typical bankwire or cheque Payment accepted
status, Order::validateOrder() with that state triggers two independent code paths that
each write a payment for the same amount. PaymentModule::validateOrder() calls
Order::addOrderPayment() directly, while the invoice-generation path in OrderInvoice
(getRestPaid() / getTotalPaid()) still treats the order as owing money on a dummy
invoice (invoice number 0) and lets the state-change logic re-trigger a second payment
insert. Both writes land in order_payment with the identical id_order and amount.
Tracked upstream as PrestaShop/PrestaShop issue #12588 and only fully patched in pull
request #19260 (PrestaShop 1.7.8.0) by making OrderInvoice::getRestPaid() return 0 for
invoices whose number is still 0.

This script only reads and reports. The order_payment resource has no DELETE route in
the core webservice, and removing the wrong row by hand risks corrupting
total_paid_real, so it never writes or deletes anything. Flagged orders need a store
admin to review and remove the extra row in Back Office > Orders, or via a backed up
direct database delete plus a recalculation of total_paid_real.

Guide: https://www.allanninal.dev/prestashop/duplicate-order-payment-row/

Run on a schedule. Safe to run again and again.
"""
import os
import datetime
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_duplicate_payments")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
PAID_AND_LOGABLE_STATE_ID = os.environ.get("PAID_AND_LOGABLE_STATE_ID", "")
AUTH = (PRESTASHOP_WS_KEY, "")


def _to_epoch(date_add):
    return datetime.datetime.fromisoformat(str(date_add).replace(" ", "T")).timestamp()


def find_duplicate_payments(payments, amount_tolerance=0.01, time_tolerance_seconds=60):
    """Pure decision function, no I/O.

    payments is a list of order_payments rows already fetched for one order, each with
    at least order_reference, amount, and date_add. Sorts by date_add, then scans
    adjacent pairs, grouping any pair whose amounts match within amount_tolerance and
    whose date_add values are within time_tolerance_seconds of each other. Returns a
    list of cluster dicts for clusters of size 2 or more.
    """
    rows = sorted(payments, key=lambda p: _to_epoch(p["date_add"]))
    clusters = []
    used = set()
    for i in range(len(rows) - 1):
        a, b = rows[i], rows[i + 1]
        if id(a) in used and id(b) in used:
            continue
        amount_a, amount_b = float(a["amount"]), float(b["amount"])
        delta_seconds = abs(_to_epoch(b["date_add"]) - _to_epoch(a["date_add"]))
        if abs(amount_a - amount_b) <= amount_tolerance and delta_seconds <= time_tolerance_seconds:
            clusters.append({
                "order_reference": a["order_reference"],
                "duplicate_payment_ids": [a.get("id"), b.get("id")],
                "amount": amount_a,
                "count": 2,
            })
            used.add(id(a))
            used.add(id(b))
    return clusters


def build_report_row(id_order, order_reference, cluster, paid_real):
    summed = cluster["amount"] * cluster["count"]
    return {
        "id_order": id_order,
        "order_reference": order_reference,
        "duplicate_payment_ids": cluster["duplicate_payment_ids"],
        "amount": cluster["amount"],
        "summed_order_payments": round(summed, 2),
        "total_paid_real": paid_real,
        "inflated": round(summed, 2) != round(paid_real, 2),
    }


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def is_paid_and_logable_state(id_state):
    data = api_get(f"order_states/{id_state}", params={"display": "full"})
    state = data.get("order_state") or {}
    return str(state.get("paid")) == "1" and str(state.get("logable")) == "1"


def orders_in_state(id_state):
    data = api_get("orders", params={"filter[current_state]": id_state, "display": "full"})
    return data.get("orders") or []


def order_payments_for(order_reference):
    data = api_get("order_payments", params={
        "filter[order_reference]": order_reference,
        "display": "full",
    })
    return data.get("order_payments") or []


def total_paid_real(id_order):
    data = api_get(f"orders/{id_order}", params={"display": "full"})
    order = data.get("order") or {}
    return float(order.get("total_paid_real", 0))


def run():
    if not PAID_AND_LOGABLE_STATE_ID:
        log.error("Set PAID_AND_LOGABLE_STATE_ID to the id_order_state to scan.")
        return
    if not is_paid_and_logable_state(PAID_AND_LOGABLE_STATE_ID):
        log.warning("State %s is not both paid and logable, scanning anyway.", PAID_AND_LOGABLE_STATE_ID)

    flagged = 0
    for order in orders_in_state(PAID_AND_LOGABLE_STATE_ID):
        id_order = order["id"]
        reference = order.get("reference")
        payments = order_payments_for(reference)
        clusters = find_duplicate_payments(payments)
        if not clusters:
            continue
        paid_real = total_paid_real(id_order)
        for cluster in clusters:
            row = build_report_row(id_order, reference, cluster, paid_real)
            flagged += 1
            log.warning(
                "Duplicate order_payment found. id_order=%s reference=%s payment_ids=%s "
                "amount=%.2f summed=%.2f total_paid_real=%.2f inflated=%s",
                row["id_order"], row["order_reference"], row["duplicate_payment_ids"],
                row["amount"], row["summed_order_payments"], row["total_paid_real"], row["inflated"],
            )
    log.info(
        "Done. %d duplicate payment cluster(s) flagged for manual review. DRY_RUN=%s "
        "(no writes are ever performed, order_payment has no DELETE route).",
        flagged, DRY_RUN,
    )


if __name__ == "__main__":
    run()
