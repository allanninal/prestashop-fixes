"""Detect PrestaShop orders whose total_paid_real has doubled after a duplicate payment.

Order::addOrderPayment() both inserts a row into order_payment and directly increments
the order's own total_paid_real column before saving the order. Nothing checks whether
a matching payment already exists, so a partial-payment workflow that triggers this
method twice for the same real-world payment, for example an auto-added payment from
Order::validateOrder() plus a separate order_history update or a payment module call,
leaves order_payment with a duplicate row and total_paid_real incremented twice. The
stored total can end up exactly double the true sum of the real payment rows.

This script flags affected orders by default. It never rewrites total_paid_real on its
own, since order_payment is the source of truth and the cached total is only derived
from it. A confirmed repair deletes the specific duplicate order_payment row, then PUTs
the order with total_paid_real recomputed from the remaining rows, only when DRY_RUN is
false and the operator has supplied the confirmed duplicate payment id.

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_total_paid_real")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
CONFIRM_DUPLICATE_PAYMENT_ID = os.environ.get("CONFIRM_DUPLICATE_PAYMENT_ID", "")
ORDER_IDS = [int(x) for x in os.environ.get("ORDER_IDS", "").split(",") if x.strip()]
AUTH = (PRESTASHOP_WS_KEY, "")

EPSILON = 0.01


def reconcile_payment(order_total_paid_real, order_payment_amounts, total_paid=None, epsilon=EPSILON):
    """Pure decision function, no I/O.

    Sums order_payment_amounts and compares that sum to order_total_paid_real within
    epsilon. mismatch is True when they disagree past the tolerance. likelyDoubled is
    True when order_total_paid_real is within epsilon of twice the real sum (or twice
    total_paid when there are no payment rows yet), which is the signature shape of the
    duplicate addOrderPayment() bug rather than an ordinary partial-payment shortfall.
    """
    sum_payments = round(sum(order_payment_amounts), 2)
    mismatch = abs(order_total_paid_real - sum_payments) > epsilon
    baseline = sum_payments if sum_payments > epsilon else (total_paid or 0)
    likely_doubled = baseline > epsilon and abs(order_total_paid_real - 2 * baseline) <= epsilon
    return {
        "mismatch": mismatch,
        "sumPayments": sum_payments,
        "delta": round(order_total_paid_real - sum_payments, 2),
        "likelyDoubled": likely_doubled,
    }


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def get_order(id_order):
    data = api_get(f"orders/{id_order}")
    return data["order"]


def order_payments_for_reference(reference):
    data = api_get("order_payments", params={
        "filter[order_reference]": reference,
        "display": "full",
    })
    payments = data.get("order_payments") or []
    if isinstance(payments, dict):
        payments = [payments]
    return payments


def delete_order_payment(id_order_payment):
    r = requests.delete(
        f"{PRESTASHOP_URL}/api/order_payments/{id_order_payment}",
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()


def put_corrected_total(order, corrected_total_paid_real):
    order = dict(order)
    order["total_paid_real"] = f"{corrected_total_paid_real:.2f}"
    r = requests.put(
        f"{PRESTASHOP_URL}/api/orders/{order['id']}",
        params={"output_format": "JSON"},
        json={"order": order},
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    flagged = 0
    repaired = 0
    for id_order in ORDER_IDS:
        order = get_order(id_order)
        reference = order["reference"]
        total_paid = float(order["total_paid"])
        total_paid_real = float(order["total_paid_real"])
        payments = order_payments_for_reference(reference)
        amounts = [float(p["amount"]) for p in payments]
        result = reconcile_payment(total_paid_real, amounts, total_paid=total_paid)
        if not result["mismatch"]:
            continue
        flagged += 1
        doubled_note = " (looks doubled, likely a duplicate addOrderPayment call)" if result["likelyDoubled"] else ""
        log.warning(
            "Order has a payment mismatch. id_order=%s reference=%s total_paid=%.2f "
            "total_paid_real=%.2f sum_order_payments=%.2f delta=%.2f%s",
            id_order, reference, total_paid, total_paid_real,
            result["sumPayments"], result["delta"], doubled_note,
        )
        if not DRY_RUN and CONFIRM_DUPLICATE_PAYMENT_ID:
            delete_order_payment(CONFIRM_DUPLICATE_PAYMENT_ID)
            remaining = [
                float(p["amount"]) for p in payments
                if str(p.get("id")) != str(CONFIRM_DUPLICATE_PAYMENT_ID)
            ]
            corrected_total = round(sum(remaining), 2)
            put_corrected_total(order, corrected_total)
            repaired += 1
            log.info(
                "Deleted duplicate order_payment id=%s and set total_paid_real=%.2f for id_order=%s.",
                CONFIRM_DUPLICATE_PAYMENT_ID, corrected_total, id_order,
            )
    log.info(
        "Done. %d order(s) flagged for review, %d repaired. DRY_RUN=%s",
        flagged, repaired, DRY_RUN,
    )


if __name__ == "__main__":
    run()
