"""Find and repair PrestaShop reserved_quantity drift from real pending orders.

stock_available.reserved_quantity is a running counter PrestaShop updates as a side
effect of order_histories inserts, not a live query. When an order state changes
outside the normal flow, the decrement can be skipped and the counter never comes
back down. This recomputes the expected reserved quantity from real open orders,
diffs it against the API, and repairs drift by reposting the order's own current
state to order_histories, which re-triggers PrestaShop's native stock recalculation.
Never writes reserved_quantity or physical_quantity directly. Safe to run again and again.

Guide: https://www.allanninal.dev/prestashop/reserved-quantity-drift/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reserved_quantity_drift")

BASE_URL = os.environ.get("PRESTASHOP_URL", "https://example.test").rstrip("/")
WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "dummy_key")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def api_get(path, params):
    params = dict(params)
    params["output_format"] = "JSON"
    r = requests.get(f"{BASE_URL}/api/{path}", params=params, auth=(WS_KEY, ""), timeout=30)
    r.raise_for_status()
    return r.json()


def logable_state_ids():
    data = api_get("order_states", {"display": "full"})
    states = data.get("order_states") or []
    return {int(s["id"]) for s in states if str(s.get("logable")) in ("1", "true", "True")}


def open_orders(logable_ids):
    data = api_get("orders", {"display": "full", "limit": "0,1000"})
    orders = data.get("orders") or []
    return [o for o in orders if int(o.get("current_state", 0)) in logable_ids]


def order_lines(id_order):
    data = api_get("order_details", {"display": "full", "filter[id_order]": id_order})
    return data.get("order_details") or []


def open_order_lines(logable_ids):
    lines = []
    for order in open_orders(logable_ids):
        id_state = int(order["current_state"])
        for line in order_lines(order["id"]):
            lines.append({
                "id_product": int(line["product_id"]),
                "id_product_attribute": int(line.get("product_attribute_id") or 0),
                "product_quantity": int(line.get("product_quantity") or 0),
                "product_quantity_refunded": int(line.get("product_quantity_refunded") or 0),
                "id_order_state": id_state,
            })
    return lines


def stock_rows():
    data = api_get("stock_availables", {"display": "full", "limit": "0,1000"})
    rows = data.get("stock_availables") or []
    return [
        {
            "id_product": int(r["id_product"]),
            "id_product_attribute": int(r.get("id_product_attribute") or 0),
            "reserved_quantity": int(r.get("reserved_quantity") or 0),
        }
        for r in rows
    ]


def compute_reserved_drift(open_order_lines, logable_ids, stock_rows_list):
    """Pure function. No I/O. See test_reserved_drift.py for fixtures."""
    expected = {}
    for line in open_order_lines:
        if line["id_order_state"] not in logable_ids:
            continue
        key = (line["id_product"], line["id_product_attribute"])
        remaining = line["product_quantity"] - line["product_quantity_refunded"]
        if remaining < 0:
            remaining = 0
        expected[key] = expected.get(key, 0) + remaining

    actual_by_key = {
        (row["id_product"], row["id_product_attribute"]): row["reserved_quantity"]
        for row in stock_rows_list
    }

    keys = set(expected) | set(actual_by_key)
    results = []
    for key in keys:
        expected_reserved = expected.get(key, 0)
        actual_reserved = actual_by_key.get(key, 0)
        if expected_reserved != actual_reserved:
            id_product, id_product_attribute = key
            results.append({
                "id_product": id_product,
                "id_product_attribute": id_product_attribute,
                "expected_reserved": expected_reserved,
                "actual_reserved": actual_reserved,
                "drift": actual_reserved - expected_reserved,
            })
    return results


def resync_order_state(id_order, id_order_state):
    body = {"order_history": {"id_order": id_order, "id_order_state": id_order_state}}
    r = requests.post(
        f"{BASE_URL}/api/order_histories",
        params={"output_format": "JSON"},
        json=body,
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def orders_touching_product(open_orders_list, id_product, id_product_attribute):
    matches = []
    for order in open_orders_list:
        for line in order_lines(order["id"]):
            if int(line["product_id"]) == id_product and int(line.get("product_attribute_id") or 0) == id_product_attribute:
                matches.append(order)
                break
    return matches


def run():
    ids = logable_state_ids()
    orders = open_orders(ids)
    lines = []
    for order in orders:
        id_state = int(order["current_state"])
        for line in order_lines(order["id"]):
            lines.append({
                "id_product": int(line["product_id"]),
                "id_product_attribute": int(line.get("product_attribute_id") or 0),
                "product_quantity": int(line.get("product_quantity") or 0),
                "product_quantity_refunded": int(line.get("product_quantity_refunded") or 0),
                "id_order_state": id_state,
            })
    rows = stock_rows()
    drifted = compute_reserved_drift(lines, ids, rows)

    for item in drifted:
        log.warning(
            "Product %s attribute %s drift: expected=%s actual=%s (%s)",
            item["id_product"], item["id_product_attribute"],
            item["expected_reserved"], item["actual_reserved"],
            "would resync" if DRY_RUN else "resyncing",
        )
        if not DRY_RUN:
            touching = orders_touching_product(orders, item["id_product"], item["id_product_attribute"])
            for order in touching:
                resync_order_state(order["id"], int(order["current_state"]))

    log.info("Done. %d drifted product/attribute row(s) %s.", len(drifted), "to resync" if DRY_RUN else "resynced")


if __name__ == "__main__":
    run()
