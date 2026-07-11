"""Detect and safely repair PrestaShop orders stuck permanently on one status.

PrestaShop keeps order status in two places: the denormalized current_state
column on the order, and the append-only order_history table that core keeps
in step through Order::setCurrentState(). A webservice PUT to the orders
resource can set current_state in the payload without reliably calling that
method, so order_history never gets a new row and the order looks frozen.

This polls in-progress orders, builds the terminal state set from order_states
instead of hardcoding it, and flags an order as stuck only when its cached
current_state agrees with the newest order_histories row and both are older
than the stale threshold. Flag-and-report is the default. Repair only ever
posts a corrective order_histories row, and only for a specific approved
order id, never a direct write to current_state. Safe to run again and again.

Guide: https://www.allanninal.dev/prestashop/order-stuck-on-stale-status/
"""
import os
import logging
import requests
from datetime import datetime, timezone

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("order_stuck_on_stale_status")

BASE_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
STALE_DAYS_THRESHOLD = float(os.environ.get("STALE_DAYS_THRESHOLD", "5"))
BOT_EMPLOYEE_ID = int(os.environ.get("PRESTASHOP_BOT_EMPLOYEE_ID", "0"))
IN_PROGRESS_STATE_IDS = [
    int(x) for x in os.environ.get("IN_PROGRESS_STATE_IDS", "1,2,3").split(",") if x.strip()
]
# Set to an order id and its confirmed state id to approve a single repair.
APPROVED_ORDER_ID = os.environ.get("APPROVED_ORDER_ID")
APPROVED_ORDER_STATE_ID = os.environ.get("APPROVED_ORDER_STATE_ID")

TERMINAL_STATE_NAMES = {"delivered", "canceled", "cancelled", "refunded", "payment error"}


def api_get(path, params):
    params = dict(params)
    params["output_format"] = "JSON"
    r = requests.get(f"{BASE_URL}/api/{path}", params=params, auth=(WS_KEY, ""), timeout=30)
    r.raise_for_status()
    return r.json()


def terminal_state_ids():
    data = api_get("order_states", {"display": "full"})
    states = data.get("order_states") or []
    ids = set()
    for s in states:
        name = str(s.get("name") or "").strip().lower()
        if name in TERMINAL_STATE_NAMES or str(s.get("shipped")) in ("1", "true", "True"):
            ids.add(int(s["id"]))
    return ids


def orders_in_state(id_order_state):
    data = api_get("orders", {"display": "full", "filter[current_state]": id_order_state})
    return data.get("orders") or []


def latest_history_row(id_order):
    data = api_get("order_histories", {
        "display": "full",
        "filter[id_order]": id_order,
        "sort": "date_add_DESC",
    })
    rows = data.get("order_histories") or []
    return rows[0] if rows else None


def is_order_stuck(current_state_id, last_history_state_id, last_update_iso,
                    now_iso, terminal_state_ids_set, stale_days_threshold=5):
    """
    Pure decision logic (no I/O):
    - current_state_id: orders.current_state from GET /api/orders/{id}
    - last_history_state_id: id_order_state of the most recent row from
      GET /api/order_histories?filter[id_order]={id}&sort=date_add_DESC (first row)
    - last_update_iso: orders.date_upd (or the date_add of that latest history row)
    - now_iso: current timestamp used by the poller
    - terminal_state_ids_set: set of id_order_state values considered final
      (built from GET /api/order_states, e.g. those with paid=1 delivered,
      or the shop's known terminal set: Delivered, Canceled, Refunded, Payment error)
    - stale_days_threshold: implausible number of days with no advancement

    Returns True (flag as stuck) when:
      1) current_state_id is not in terminal_state_ids_set, AND
      2) days_between(last_update_iso, now_iso) > stale_days_threshold, AND
      3) last_history_state_id == current_state_id
         (history genuinely hasn't advanced -- distinguishes a truly stuck
         order from one where order_histories moved on but the cached
         orders.current_state failed to sync, which is a desync, not a stall)
    """
    if current_state_id in terminal_state_ids_set:
        return False
    last_dt = datetime.fromisoformat(last_update_iso)
    now_dt = datetime.fromisoformat(now_iso)
    days_idle = (now_dt - last_dt).days
    if days_idle <= stale_days_threshold:
        return False
    return last_history_state_id == current_state_id


def post_corrective_history(id_order, id_order_state, id_employee):
    body = {
        "order_history": {
            "id_order": id_order,
            "id_order_state": id_order_state,
            "id_employee": id_employee,
        }
    }
    r = requests.post(
        f"{BASE_URL}/api/order_histories",
        params={"output_format": "JSON", "sendemail": "0"},
        json=body,
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def find_stuck_orders():
    terminal_ids = terminal_state_ids()
    now_iso = datetime.now(timezone.utc).isoformat()
    stuck = []
    for id_state in IN_PROGRESS_STATE_IDS:
        for order in orders_in_state(id_state):
            id_order = int(order["id"])
            current_state_id = int(order.get("current_state", id_state))
            last_update_iso = order.get("date_upd") or order.get("date_add")
            if not last_update_iso:
                continue
            history_row = latest_history_row(id_order)
            last_history_state_id = int(history_row["id_order_state"]) if history_row else current_state_id
            if is_order_stuck(current_state_id, last_history_state_id, last_update_iso,
                               now_iso, terminal_ids, STALE_DAYS_THRESHOLD):
                stuck.append({
                    "id_order": id_order,
                    "current_state": current_state_id,
                    "last_history_state": last_history_state_id,
                    "last_update": last_update_iso,
                })
    return stuck


def run():
    stuck = find_stuck_orders()
    for item in stuck:
        log.warning(
            "Order %s stuck on state %s since %s (history agrees: %s)",
            item["id_order"], item["current_state"], item["last_update"],
            item["last_history_state"] == item["current_state"],
        )

    if not DRY_RUN and APPROVED_ORDER_ID and APPROVED_ORDER_STATE_ID:
        id_order = int(APPROVED_ORDER_ID)
        id_state = int(APPROVED_ORDER_STATE_ID)
        log.info("Repairing order %s with confirmed state %s", id_order, id_state)
        post_corrective_history(id_order, id_state, BOT_EMPLOYEE_ID)

    log.info("Done. %d order(s) flagged as stuck.", len(stuck))


if __name__ == "__main__":
    run()
