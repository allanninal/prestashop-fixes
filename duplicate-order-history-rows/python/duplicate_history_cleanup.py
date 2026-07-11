"""Flag and clean up duplicate PrestaShop order_history rows for a single status change.

Order::setCurrentState() historically ran its full body, insert order_history,
send the email, fire the hooks, every time it was called, without checking whether
the order already had the requested state. A retried webhook, a duplicated IPN call,
or a webservice client blindly re-sending current_state can insert the same
order_history row twice. This script reports duplicate ids by default. Only with
DRY_RUN=false does it delete the flagged duplicate ids, never the first row of a
run and never the order's current_state field. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("duplicate_history_cleanup")

BASE_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{BASE_URL}/api/{path}", params=params, auth=(WS_KEY, ""), timeout=30)
    r.raise_for_status()
    return r.json()


def api_delete(path):
    r = requests.delete(
        f"{BASE_URL}/api/{path}",
        params={"output_format": "JSON"},
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return True


def find_duplicate_history_ids(history_rows):
    """Pure decision function, no I/O.

    Input: history_rows, a list of dicts with at least
    {"id": int, "id_order_state": int, "date_add": str (ISO-8601 or PrestaShop
    "YYYY-MM-DD HH:MM:SS")}, already scoped to one id_order.

    Sorts a copy of history_rows by (date_add, id) ascending, then walks the
    list tracking the previous row's id_order_state. Whenever the current row's
    id_order_state equals the previous row's, the current row's id is flagged
    as a duplicate. The earlier row in each run is always kept, only the
    repeat(s) are flagged. The tracker resets to the current row's state after
    every comparison, so a run longer than two is fully flagged except the
    first row. Returns the list of duplicate ids (empty list if none).
    """
    if not history_rows:
        return []
    ordered = sorted(history_rows, key=lambda r: (r["date_add"], r["id"]))
    duplicate_ids = []
    previous_state = None
    for row in ordered:
        if previous_state is not None and row["id_order_state"] == previous_state:
            duplicate_ids.append(row["id"])
        previous_state = row["id_order_state"]
    return duplicate_ids


def order_history_rows(id_order):
    data = api_get("order_histories", {
        "filter[id_order]": id_order,
        "display": "full",
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


def delete_duplicate_history(id_order_history):
    return api_delete(f"order_histories/{id_order_history}")


def run():
    flagged = 0
    for id_order in order_ids_to_check():
        rows = order_history_rows(id_order)
        duplicate_ids = find_duplicate_history_ids(rows)
        if not duplicate_ids:
            continue
        flagged += len(duplicate_ids)
        log.warning("Order %s has duplicate order_history ids: %s", id_order, duplicate_ids)
        if DRY_RUN:
            log.info("DRY RUN: would delete order_histories %s for order %s", duplicate_ids, id_order)
        else:
            for id_order_history in duplicate_ids:
                delete_duplicate_history(id_order_history)
            remaining = order_history_rows(id_order)
            remaining_states = [r["id_order_state"] for r in remaining]
            log.info("Order %s cleaned up. Remaining history states: %s", id_order, remaining_states)
    log.info("Done. %d duplicate order_history row(s) %s.", flagged, "to delete" if DRY_RUN else "deleted")


if __name__ == "__main__":
    run()
