"""Detect PrestaShop orders whose order_history does not match their current_state.

PrestaShop keeps two representations of an order's status in sync by convention, not
by a database constraint: the denormalized orders.current_state column, and the
append-only order_history (ps_order_history) audit trail that is supposed to gain a
new row every time the state changes. When OrderHistory::changeIdOrderState() or
addWithemail() is interrupted, a crash during order creation, a module or webservice
call that writes current_state directly, or a broken insert like the id_employee
mismatch seen after the 8.1.0 upgrade (GitHub #33238), the order ends up pointing at a
state that has no matching history record. Related reports (#21502, #27967) show this
happening intermittently on payment-confirmation transitions and after upgrades.

This script flags affected orders by default. It never edits orders.current_state
directly, since that column must only change as a side effect of an order_histories
insert. A confirmed repair posts a synthetic order_history row tagged id_employee=0,
mirroring what OrderHistory::addWithemail() would have inserted, only when DRY_RUN is
false and the operator has explicitly confirmed it.

Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/prestashop/order-history-missing-for-current-state/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_order_history")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
CONFIRM_REPAIR = os.environ.get("CONFIRM_REPAIR", "false").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def needs_history_backfill(current_state, history_states):
    """Pure decision function, no I/O.

    current_state: int, the order's orders.current_state value.
    history_states: list of (id_order_state, date_add) tuples, in any order; this
        function sorts by date_add descending internally, so the caller does not have
        to pre-sort.

    Returns a dict describing the problem, or None when the order's history already
    matches current_state:
      - {"reason": "no_history", "expected_state": current_state} when history_states
        is empty.
      - {"reason": "state_mismatch", "expected_state": current_state,
         "last_recorded_state": ..., "last_recorded_date": ...} when the latest history
        row (by date_add) does not have id_order_state == current_state.
      - None when the order is consistent.
    """
    if not history_states:
        return {"reason": "no_history", "expected_state": current_state}
    latest = max(history_states, key=lambda row: row[1])
    if latest[0] != current_state:
        return {
            "reason": "state_mismatch",
            "expected_state": current_state,
            "last_recorded_state": latest[0],
            "last_recorded_date": latest[1],
        }
    return None


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def all_orders():
    data = api_get("orders", params={"display": "[id,current_state,reference]", "limit": "0"})
    return data.get("orders") or []


def order_history_rows(id_order):
    data = api_get("order_histories", params={
        "filter[id_order]": id_order,
        "display": "[id,id_order,id_order_state,date_add]",
        "sort": "id_DESC",
    })
    return data.get("order_histories") or []


def valid_order_state_ids():
    data = api_get("order_states", params={})
    states = data.get("order_states") or []
    return {int(s["id"]) for s in states}


def backfill_order_history(id_order, expected_state):
    """POST a synthetic order_history row, mirroring OrderHistory::addWithemail().

    Tagged id_employee=0 to mark it as a system-generated backfill. Never edits
    orders.current_state directly.
    """
    body = {"order_history": {"id_order": id_order, "id_order_state": expected_state, "id_employee": 0}}
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
    valid_states = valid_order_state_ids()
    flagged = 0
    repaired = 0
    for order in all_orders():
        id_order = order["id"]
        current_state = int(order["current_state"])
        rows = order_history_rows(id_order)
        history_states = [(int(row["id_order_state"]), row["date_add"]) for row in rows]
        problem = needs_history_backfill(current_state, history_states)
        if problem is None:
            continue
        flagged += 1
        orphaned_note = ""
        if problem["reason"] == "state_mismatch" and problem["last_recorded_state"] not in valid_states:
            orphaned_note = " (last recorded state id is orphaned, no longer a valid order_state)"
        log.warning(
            "Order needs history backfill. id_order=%s reference=%s current_state=%s reason=%s "
            "last_history_state=%s last_history_date=%s%s",
            id_order, order.get("reference"), current_state, problem["reason"],
            problem.get("last_recorded_state"), problem.get("last_recorded_date"), orphaned_note,
        )
        if not DRY_RUN and CONFIRM_REPAIR:
            backfill_order_history(id_order, current_state)
            repaired += 1
            log.info("Backfilled order_history for id_order=%s to state=%s (id_employee=0).", id_order, current_state)
    log.info(
        "Done. %d order(s) flagged for review, %d repaired. DRY_RUN=%s CONFIRM_REPAIR=%s",
        flagged, repaired, DRY_RUN, CONFIRM_REPAIR,
    )


if __name__ == "__main__":
    run()
