"""Detect and repair PrestaShop orders whose current_state has gone stale.

PrestaShop keeps two representations of an order's status: the append-only
order_history table, one row per transition, and a denormalized current_state
column on the orders row, kept purely as a read-optimization for order lists,
filters, and exports. The core only synchronizes these inside
Order::setCurrentState() and OrderHistory::addWithemail(), which insert a new
history row and then write that same state into orders.current_state in the
same call. If a history row is deleted or edited directly, by a bad module, a
GDPR or cleanup script, a manual database fix, or an admin removing a
wrongly-added status line, that write path is bypassed, so current_state keeps
pointing at whatever was last set and silently diverges from what the history
now shows as most recent. This is the desync reported in PrestaShop GitHub
issue #13390.

This script logs every stale pointer it finds. It never inserts a new
order_history row for a correction, since that would trigger a customer
notification email and further pollute an already-edited history. A confirmed
repair only overwrites orders.current_state, and only when DRY_RUN is false.
Orders with zero history rows are skipped and flagged, since there is no safe
state to recompute from.

Guide: https://www.allanninal.dev/prestashop/order-current-state-stale-after-history-edit/

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_stale_current_state")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
PRESTASHOP_WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def compute_correct_current_state(history_rows):
    """Pure decision function, no I/O.

    history_rows is a list of dicts, each with at least "id", "id_order_state",
    and "date_add" as an ISO-ish string, in any order. Returns the
    id_order_state of the row with the lexicographically-max date_add,
    breaking ties by the largest id (order_history ids are auto-increment and
    insert-ordered). Returns None when history_rows is empty, which signals
    "flag this order, do not repair it."
    """
    if not history_rows:
        return None
    best = max(
        history_rows,
        key=lambda row: (row.get("date_add") or "", int(row["id"])),
    )
    return int(best["id_order_state"])


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
        "display": "[id,id_order_state,date_add]",
    })
    return data.get("order_histories") or []


def patch_current_state(id_order, correct_state):
    body = api_get(f"orders/{id_order}")
    body["order"]["current_state"] = str(correct_state)
    r = requests.put(
        f"{PRESTASHOP_URL}/api/orders/{id_order}",
        params={"output_format": "JSON"},
        json=body,
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    flagged = 0
    repaired = 0
    for order in all_orders():
        id_order = order["id"]
        stale_state = int(order["current_state"])
        rows = order_history_rows(id_order)
        correct_state = compute_correct_current_state(rows)
        if correct_state is None:
            flagged += 1
            log.warning("Order id_order=%s reference=%s has zero order_history rows. Skipping, flagged for review.",
                        id_order, order.get("reference"))
            continue
        if correct_state == stale_state:
            continue
        flagged += 1
        log.info(
            "Order id_order=%s reference=%s stale_current_state=%s correct_current_state=%s. %s",
            id_order, order.get("reference"), stale_state, correct_state,
            "would patch" if DRY_RUN else "patching",
        )
        if not DRY_RUN:
            patch_current_state(id_order, correct_state)
            repaired += 1
    log.info("Done. %d order(s) flagged, %d %s.", flagged, repaired,
              "would be patched" if DRY_RUN else "patched")


if __name__ == "__main__":
    run()
