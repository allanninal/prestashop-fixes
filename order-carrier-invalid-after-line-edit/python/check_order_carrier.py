"""Detect PrestaShop orders whose carrier reference has gone invalid.

PrestaShop never removes a carrier row when you delete it in the back office, it only
sets carrier.deleted = 1, so old orders keep pointing at an id that is now hidden from
every UI and most webservice lists. Editing a carrier's settings is worse: PrestaShop
duplicates the row under the same id_reference and hides the old one, so historic orders
keep referencing a dead id. Editing an order's product lines can trigger a shipping
recalculation that surfaces "The order carrier ID is invalid" (core issue #24307), and
core issue #17355 documents that the back office then blocks editing that order's
shipping and tracking at all. A webservice bug (#11945) can also leave id_carrier at 0.

This script flags affected orders by default. It never repoints an order's carrier unless
DRY_RUN is explicitly false, and even then it only writes when a currently active carrier
shares the dead carrier's id_reference. Every other case is left for a human.

Guide: https://www.allanninal.dev/prestashop/order-carrier-invalid-after-line-edit/

Run against recent orders on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_order_carrier")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
DATE_UPD_FROM = os.environ.get("DATE_UPD_FROM", "")
AUTH = (PRESTASHOP_WS_KEY, "")


def classify_order_carrier(order_id_carrier, valid_carrier_ids, deleted_carrier_ids):
    """Pure decision logic, no I/O.

    Returns "zero" if order_id_carrier is 0 or None, "deleted" if it is a known
    soft-deleted carrier id, "missing" if it is not in either set, otherwise "ok".
    """
    if order_id_carrier == 0 or order_id_carrier is None:
        return "zero"
    if order_id_carrier in deleted_carrier_ids:
        return "deleted"
    if order_id_carrier not in valid_carrier_ids and order_id_carrier not in deleted_carrier_ids:
        return "missing"
    return "ok"


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def api_put(path, body):
    r = requests.put(
        f"{PRESTASHOP_URL}/api/{path}",
        params={"output_format": "JSON"},
        json=body,
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def list_orders(date_upd_from=None):
    params = {"display": "full"}
    if date_upd_from:
        params["filter[date_upd]"] = f">[{date_upd_from}]"
    data = api_get("orders", params=params)
    return data.get("orders") or []


def carrier_sets():
    data = api_get("carriers", params={"display": "full", "filter[deleted]": "[0,1]"})
    carriers = data.get("carriers") or []
    valid_ids = {int(c["id"]) for c in carriers if str(c.get("deleted")) == "0"}
    deleted_ids = {int(c["id"]) for c in carriers if str(c.get("deleted")) == "1"}
    return valid_ids, deleted_ids


def carrier_by_id(id_carrier):
    # Deleted rows remain readable by exact id even though they are hidden from lists.
    data = api_get(f"carriers/{id_carrier}", params={})
    return (data or {}).get("carrier")


def order_carrier_rows(id_order):
    data = api_get("order_carriers", params={"filter[id_order]": id_order, "display": "full"})
    return data.get("order_carriers") or []


def carrier_with_reference(active_carriers, id_reference):
    for c in active_carriers:
        if str(c.get("id_reference")) == str(id_reference) and str(c.get("deleted")) == "0":
            return c
    return None


def build_report_row(order, reason, dead_carrier):
    return {
        "id": order["id"],
        "reference": order.get("reference"),
        "id_carrier": order.get("id_carrier"),
        "carrier_valid": False,
        "reason": reason,
        "last_known_id_reference": (dead_carrier or {}).get("id_reference"),
    }


def repoint_order_carrier(order, order_carrier_row, new_id_carrier):
    order["id_carrier"] = new_id_carrier
    api_put(f"orders/{order['id']}", {"order": order})
    if order_carrier_row:
        order_carrier_row["id_carrier"] = new_id_carrier
        api_put(f"order_carriers/{order_carrier_row['id']}", {"order_carrier": order_carrier_row})
    api_put("order_histories", {"order_history": {"id_order": order["id"], "id_order_state": order.get("current_state")}})


def run():
    orders = list_orders(DATE_UPD_FROM or None)
    valid_ids, deleted_ids = carrier_sets()
    all_carriers_data = api_get("carriers", params={"display": "full", "filter[deleted]": "[0,1]"})
    all_carriers = all_carriers_data.get("carriers") or []

    flagged = 0
    repaired = 0
    for order in orders:
        id_carrier = order.get("id_carrier")
        id_carrier = int(id_carrier) if id_carrier not in (None, "") else 0
        reason = classify_order_carrier(id_carrier, valid_ids, deleted_ids)
        if reason == "ok":
            continue

        flagged += 1
        dead_carrier = carrier_by_id(id_carrier) if id_carrier else None
        row = build_report_row(order, reason, dead_carrier)
        log.warning(
            "Invalid order carrier. id=%s reference=%s id_carrier=%s reason=%s last_known_id_reference=%s",
            row["id"], row["reference"], row["id_carrier"], row["reason"], row["last_known_id_reference"],
        )

        if not DRY_RUN and dead_carrier and dead_carrier.get("id_reference"):
            replacement = carrier_with_reference(all_carriers, dead_carrier["id_reference"])
            if replacement:
                oc_rows = order_carrier_rows(order["id"])
                oc_row = oc_rows[0] if oc_rows else None
                repoint_order_carrier(order, oc_row, int(replacement["id"]))
                repaired += 1
                log.info("Repointed id_order=%s to active carrier id=%s.", order["id"], replacement["id"])
            else:
                log.warning("Skipping repair for id_order=%s: no active carrier shares id_reference=%s.",
                            order["id"], dead_carrier["id_reference"])

    log.info("Done. %d order(s) flagged, %d repointed. DRY_RUN=%s", flagged, repaired, DRY_RUN)


if __name__ == "__main__":
    run()
