"""Find PrestaShop orders that reached a paid state despite the product being out of stock.

PrestaShop checks stock when an item is added to the cart, but never re-verifies
stock_available against the cart at the final checkout step or inside a payment
module's validateOrder() callback. If stock is depleted by a concurrent order, or a
module writes a paid state directly, the order ends up paid while the product's
out_of_stock policy denies backorders and quantity is 0 or lower.

This script only reports. The optional, DRY_RUN-guarded corrective step only ever adds
an order_histories entry to an existing, human-approved review state; it never edits
orders.current_state directly and never invents a new paid or unpaid transition.
Safe to run again and again.
"""
import os
import time
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("audit_paid_out_of_stock")

BASE_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUDIT_WINDOW_DAYS = int(os.environ.get("AUDIT_WINDOW_DAYS", "30"))
REVIEW_STATE_ID = os.environ.get("REVIEW_STATE_ID")  # human-approved id_order_state, optional


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


def paid_state_ids():
    data = api_get("order_states", {"filter[paid]": "1", "display": "full"})
    states = data.get("order_states") or []
    return [int(s["id"]) for s in states]


def paid_orders(paid_ids, date_from, date_to):
    ids_filter = "[" + "|".join(str(i) for i in paid_ids) + "]"
    data = api_get("orders", {
        "filter[current_state]": ids_filter,
        "display": "full",
        "date": "1",
        "filter[date_add]": f"[{date_from},{date_to}]",
    })
    return data.get("orders") or []


def order_lines(order_id):
    data = api_get("order_details", {"filter[id_order]": order_id, "display": "full"})
    rows = data.get("order_details") or []
    return [{
        "productId": int(r["product_id"]),
        "productAttributeId": int(r.get("product_attribute_id") or 0),
        "productQuantity": int(r["product_quantity"]),
    } for r in rows]


def stock_for_line(product_id, product_attribute_id):
    data = api_get("stock_availables", {
        "filter[id_product]": product_id,
        "filter[id_product_attribute]": product_attribute_id,
        "display": "full",
    })
    rows = data.get("stock_availables") or []
    if not rows:
        return None
    row = rows[0]
    return {"quantity": int(row["quantity"]), "outOfStock": int(row["out_of_stock"])}


def decide_out_of_stock_paid_flag(order_id, current_state_id, paid_state_ids_set, order_lines_list, stock_by_line_key):
    """Pure decision function. No I/O.

    order_lines_list: [{ productId, productAttributeId, productQuantity }]
    stock_by_line_key: dict "productId:productAttributeId" -> { quantity, outOfStock }
    """
    is_paid = current_state_id in paid_state_ids_set
    if not is_paid:
        return {"flagged": False, "reasons": []}

    reasons = []
    for line in order_lines_list:
        key = f"{line['productId']}:{line['productAttributeId']}"
        stock = stock_by_line_key.get(key)
        if stock is None:
            continue
        deny_backorder = stock["outOfStock"] == 0
        insufficient = stock["quantity"] < line["productQuantity"] or stock["quantity"] <= 0
        if deny_backorder and insufficient:
            reasons.append(
                f"line {key}: qty {stock['quantity']} < needed {line['productQuantity']}, backorders denied"
            )

    return {"flagged": len(reasons) > 0, "reasons": reasons}


def post_review_history(order_id, review_state_id):
    body = {"order_history": {"id_order": order_id, "id_order_state": review_state_id}}
    if DRY_RUN or not review_state_id:
        log.info("Dry run (or no review_state_id): would POST order_histories %s", body)
        return None
    return api_post("order_histories", body)


def run():
    paid_ids = paid_state_ids()
    date_to = time.strftime("%Y-%m-%d")
    date_from = time.strftime(
        "%Y-%m-%d", time.localtime(time.time() - AUDIT_WINDOW_DAYS * 86400)
    )
    flagged = 0
    for order in paid_orders(paid_ids, date_from, date_to):
        order_id = int(order["id"])
        current_state_id = int(order["current_state"])
        lines = order_lines(order_id)
        stock_by_key = {}
        for line in lines:
            key = f"{line['productId']}:{line['productAttributeId']}"
            stock = stock_for_line(line["productId"], line["productAttributeId"])
            if stock is not None:
                stock_by_key[key] = stock

        decision = decide_out_of_stock_paid_flag(order_id, current_state_id, paid_ids, lines, stock_by_key)
        if not decision["flagged"]:
            continue

        for reason in decision["reasons"]:
            log.warning("Order %s flagged: %s", order_id, reason)
        if REVIEW_STATE_ID:
            post_review_history(order_id, int(REVIEW_STATE_ID))
        flagged += 1

    log.info("Done. %d order(s) flagged for paid-despite-out-of-stock.", flagged)


if __name__ == "__main__":
    run()
