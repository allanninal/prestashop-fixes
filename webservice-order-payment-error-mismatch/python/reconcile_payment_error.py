"""Detect and safely repair PrestaShop orders stuck in Payment error after webservice creation.

Order validation, PaymentModule::validateOrder() and, on some 1.7.x releases,
Order::createOrderFromCart() where the check moved (PrestaShop/PrestaShop#15834),
compares the cart's computed total against the amount_paid the caller supplied and
forces the order into Configuration::PS_OS_ERROR, the Payment error state, whenever
number_format(cart_total_paid, precision) != number_format(amount_paid, precision).
Webservice integrations often omit or miscalculate total_shipping or total_paid_real,
since the API never computes shipping or tax for you, so the number sent and the
number the order actually settles on drift apart.

This script lists orders in the error state, reads each order_payments row, recomputes
the true cart total, and only ever writes for the safe, deterministic case: the order's
own total_paid already agrees with the cart, but the recorded payment amount does not.
If total_paid itself diverges from the cart, the order is flagged for manual review,
since changing total_paid affects invoicing and accounting integrity.

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_payment_error")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
ERROR_STATE_ID = int(os.environ.get("ERROR_STATE_ID", "8"))
PAID_STATE_ID = int(os.environ.get("PAID_STATE_ID", "2"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def decide_order_payment_repair(order, order_payment, computed_cart_total, precision=2):
    """Pure decision function, no I/O.

    order: {id, total_paid, total_paid_real, current_state}
    order_payment: {amount} or None
    computed_cart_total: number, total_products_wt + total_shipping - total_discounts

    Returns a dict with one of three actions:
      - "none": totals already agree, nothing to do.
      - "correct_payment_amount": the order's own total_paid already matches the
        recomputed cart total, but the order_payments.amount row disagrees with it.
        Safe, deterministic fix: correct the payment row to match total_paid.
      - "flag_manual_review": either there is no order_payments row to compare
        against, or total_paid itself diverges from the recomputed cart total.
        Never auto-corrected, since total_paid feeds invoicing and accounting.
    """
    def r(n):
        return round(float(n), precision)

    order_total = r(order["total_paid"])
    cart_total = r(computed_cart_total)

    if order_payment is None:
        return {"action": "flag_manual_review", "reason": "no_order_payment_row_found"}

    paid_amount = r(order_payment["amount"])

    if order_total != cart_total:
        return {"action": "flag_manual_review", "reason": "order_total_paid_diverges_from_cart_total"}

    if paid_amount != order_total:
        return {
            "action": "correct_payment_amount",
            "reason": "order_payment_amount_mismatches_order_total_paid",
            "corrected_amount": order_total,
        }

    return {"action": "none", "reason": "totals_reconciled"}


def computed_cart_total(cart):
    """Pure helper: total_products_wt + total_shipping - total_discounts, rounded to 2dp."""
    products = float(cart.get("total_products_wt", 0))
    shipping = float(cart.get("total_shipping", 0))
    discounts = float(cart.get("total_discounts", 0))
    return round(products + shipping - discounts, 2)


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def orders_in_error():
    data = api_get("orders", params={
        "filter[current_state]": f"[{ERROR_STATE_ID}]",
        "display": "full",
    })
    return data.get("orders") or []


def order_payment_for(reference):
    data = api_get("order_payments", params={
        "filter[order_reference]": reference,
        "display": "full",
    })
    rows = data.get("order_payments") or []
    return rows[0] if rows else None


def cart_total_for(id_cart):
    data = api_get(f"carts/{id_cart}", params={"display": "full"})
    cart = data.get("cart") or {}
    return computed_cart_total(cart)


def correct_order_payment(order_payment, corrected_amount):
    body = {"order_payment": {
        "id": order_payment["id"],
        "order_reference": order_payment["order_reference"],
        "amount": corrected_amount,
        "payment_method": order_payment.get("payment_method"),
        "date_add": order_payment.get("date_add"),
    }}
    r = requests.put(
        f"{PRESTASHOP_URL}/api/order_payments/{order_payment['id']}",
        params={"output_format": "JSON"},
        json=body,
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def advance_order_state(id_order, id_order_state):
    body = {"order_history": {"id_order": id_order, "id_order_state": id_order_state, "id_employee": 0}}
    r = requests.post(
        f"{PRESTASHOP_URL}/api/order_histories",
        params={"output_format": "JSON"},
        json=body,
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    repaired = 0
    flagged = 0
    for order in orders_in_error():
        id_order = order["id"]
        reference = order.get("reference")
        payment = order_payment_for(reference)
        cart_total = cart_total_for(order["id_cart"])
        decision = decide_order_payment_repair(order, payment, cart_total)

        if decision["action"] == "none":
            continue

        if decision["action"] == "flag_manual_review":
            flagged += 1
            log.warning("Order %s (id=%s) flagged for manual review: %s",
                        reference, id_order, decision["reason"])
            continue

        old_amount = payment["amount"]
        new_amount = decision["corrected_amount"]
        log.info("Order %s (id=%s) payment amount %s -> %s. %s",
                 reference, id_order, old_amount, new_amount,
                 "would correct" if DRY_RUN else "correcting")
        if DRY_RUN:
            continue

        correct_order_payment(payment, new_amount)
        advance_order_state(id_order, PAID_STATE_ID)
        repaired += 1

    log.info("Done. %d order(s) repaired, %d flagged for review. DRY_RUN=%s", repaired, flagged, DRY_RUN)


if __name__ == "__main__":
    run()
