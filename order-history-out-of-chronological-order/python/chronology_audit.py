"""Flag PrestaShop orders whose order_history rows are out of chronological order.

order_history.date_add records write time, not true business time, so
current_state can end up disagreeing with the row that actually happened last.
This script reports only. It never edits current_state or deletes/reorders
order_history rows. Only with DRY_RUN=false and an explicit correct state does
it append one new, correctly ordered order_history row per confirmed order.
Safe to run again and again.

Guide: https://www.allanninal.dev/prestashop/order-history-out-of-chronological-order/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("chronology_audit")

BASE_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{BASE_URL}/api/{path}", params=params, auth=(WS_KEY, ""), timeout=30)
    r.raise_for_status()
    return r.json()


def api_post(path, body):
    r = requests.post(
        f"{BASE_URL}/api/{path}",
        params={"output_format": "JSON"},
        json=body,
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def find_chronology_violation(history_rows, current_state):
    """Pure decision logic, no I/O.

    history_rows: list of {"id": int, "id_order_state": int, "date_add": str}
    current_state: int, the order's current_state field.

    Sorts by (date_add, id) ascending, using id as the tiebreaker/true-insertion
    order signal since date_add can collide at second granularity. Returns a
    violation dict, or None when there is no violation.
    """
    if not history_rows:
        return None
    ordered = sorted(history_rows, key=lambda r: (r["date_add"], r["id"]))
    latest = ordered[-1]
    if latest["id_order_state"] != current_state:
        return {
            "reason": "current_state_mismatch",
            "latest_history_state": latest["id_order_state"],
            "current_state": current_state,
            "latest_id": latest["id"],
        }
    for prev, nxt in zip(ordered, ordered[1:]):
        if prev["date_add"] == nxt["date_add"] and prev["id_order_state"] != nxt["id_order_state"]:
            return {"reason": "duplicate_timestamp_ambiguous_order", "rows": [prev, nxt]}
    return None


def order_current_state(id_order):
    data = api_get(f"orders/{id_order}", {"output_format": "JSON"})
    return int(data["order"]["current_state"])


def order_history_rows(id_order):
    data = api_get("order_histories", {
        "filter[id_order]": id_order,
        "display": "full",
        "sort": "id_desc",
    })
    rows = data.get("order_histories") or []
    if isinstance(rows, dict):
        rows = [rows]
    return [
        {"id": int(r["id"]), "id_order_state": int(r["id_order_state"]), "date_add": r["date_add"]}
        for r in rows
    ]


def order_ids_to_check():
    data = api_get("orders", {"display": "full", "limit": "0,200"})
    orders = data.get("orders") or []
    if isinstance(orders, dict):
        orders = [orders]
    return [int(o["id"]) for o in orders]


def append_correct_history(id_order, id_order_state, id_employee):
    body = {
        "order_history": {
            "id_order": id_order,
            "id_order_state": id_order_state,
            "id_employee": id_employee,
        }
    }
    return api_post("order_histories", body)


def run():
    flagged = 0
    for id_order in order_ids_to_check():
        current_state = order_current_state(id_order)
        rows = order_history_rows(id_order)
        violation = find_chronology_violation(rows, current_state)
        if violation is None:
            continue
        flagged += 1
        log.warning("Order %s chronology violation: %s", id_order, violation)
        if DRY_RUN:
            log.info(
                "DRY RUN: would POST order_histories %s",
                {"order_history": {"id_order": id_order, "id_order_state": "<confirm manually>", "id_employee": "<id>"}},
            )
        else:
            log.info("Skipping write: correct state must be confirmed by a human before calling "
                      "append_correct_history(id_order, correct_state, id_employee) explicitly.")
    log.info("Done. %d order(s) flagged for review.", flagged)


if __name__ == "__main__":
    run()
