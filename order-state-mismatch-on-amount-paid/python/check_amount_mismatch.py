"""Detect PrestaShop orders whose total_paid_real does not match total_paid.

Order validation writes whatever state a payment module or the back office asks for,
along with the matching order_histories row, without independently re-checking that
total_paid_real actually equals total_paid. A module that confirms an order on a
partial payment, a currency rounding difference, or a manual state change in the back
office can all leave an order sitting on a normal, paid-looking state while the two
amount fields disagree underneath it.

This script flags affected orders by default. It never edits total_paid,
total_paid_real, or current_state directly, since a state change should only ever
happen through a new order_histories row. A confirmed repair posts that new row with
the state a human decided the order should actually be in, only when DRY_RUN is false
and the operator has explicitly confirmed it.

Guide: https://www.allanninal.dev/prestashop/order-state-mismatch-on-amount-paid/

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_amount_mismatch")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
CONFIRM_REPAIR = os.environ.get("CONFIRM_REPAIR", "false").lower() == "true"
REVIEWED_STATE = int(os.environ.get("REVIEWED_STATE", "0"))
AUTH = (PRESTASHOP_WS_KEY, "")

TOLERANCE = 0.01


def amount_mismatch(total_paid, total_paid_real, current_state, paid_state_ids):
    """Pure decision function, no I/O.

    Compares total_paid_real against total_paid with a small rounding tolerance.
    Returns a dict describing the problem, including whether current_state is one
    PrestaShop itself flags as paid, or None when the amounts already agree.
    """
    diff = round(total_paid_real - total_paid, 2)
    if abs(diff) <= TOLERANCE:
        return None
    return {
        "reason": "amount_mismatch",
        "total_paid": total_paid,
        "total_paid_real": total_paid_real,
        "difference": diff,
        "current_state_is_paid": current_state in paid_state_ids,
    }


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def all_orders():
    data = api_get("orders", params={
        "display": "[id,reference,current_state,total_paid,total_paid_real]",
        "limit": "0",
    })
    return data.get("orders") or []


def paid_state_ids():
    data = api_get("order_states", params={"display": "[id,paid]"})
    states = data.get("order_states") or []
    return {int(s["id"]) for s in states if str(s.get("paid")) in ("1", "true", "True")}


def apply_reviewed_state(id_order, reviewed_state):
    body = {"order_history": {"id_order": id_order, "id_order_state": reviewed_state, "id_employee": 0}}
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
    paid_states = paid_state_ids()
    flagged = 0
    repaired = 0
    for order in all_orders():
        id_order = order["id"]
        current_state = int(order["current_state"])
        total_paid = float(order["total_paid"])
        total_paid_real = float(order["total_paid_real"])
        problem = amount_mismatch(total_paid, total_paid_real, current_state, paid_states)
        if problem is None:
            continue
        flagged += 1
        urgent_note = " (current state claims to be paid)" if problem["current_state_is_paid"] else ""
        log.warning(
            "Order has an amount mismatch. id_order=%s reference=%s current_state=%s "
            "total_paid=%.2f total_paid_real=%.2f difference=%.2f%s",
            id_order, order.get("reference"), current_state,
            total_paid, total_paid_real, problem["difference"], urgent_note,
        )
        if not DRY_RUN and CONFIRM_REPAIR and REVIEWED_STATE:
            apply_reviewed_state(id_order, REVIEWED_STATE)
            repaired += 1
            log.info("Applied reviewed state=%s for id_order=%s (id_employee=0).", REVIEWED_STATE, id_order)
    log.info(
        "Done. %d order(s) flagged for review, %d repaired. DRY_RUN=%s CONFIRM_REPAIR=%s",
        flagged, repaired, DRY_RUN, CONFIRM_REPAIR,
    )


if __name__ == "__main__":
    run()
