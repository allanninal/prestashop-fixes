"""Detect restocks that a PrestaShop webservice write will never announce on its own.

A webservice PATCH or PUT to stock_availables updates the quantity through a plain ORM
save. It never calls the admin product controller or StockAvailable business logic that
core hooks like actionUpdateQuantity are wired to, so the back in stock alert module,
and any custom module listening on that hook, never runs. The number in the database is
correct; nothing downstream of the hook ever finds out.

This script keeps its own record of the last quantity seen per product, reads the real
current quantity from stock_availables after any update, and flags a genuine restock
notification only when an active, visible product moves from zero or below to a positive
quantity. It never sends the alert itself, it hands the id_product to your own mailer,
queue, or task tracker, since content and subscriber handling belong to your system.

Run right after your stock sync job. Safe to run again and again.
"""
import os
import json
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_restock_alerts")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
PRESTASHOP_WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
LAST_SEEN_PATH = os.environ.get("LAST_SEEN_PATH", "last_seen_quantities.json")
AUTH = (PRESTASHOP_WS_KEY, "")


def decide_restock_alert(previous_quantity, current_quantity, is_active, visibility):
    """Pure decision function, no I/O.

    previous_quantity: the quantity this script last recorded for the product, or None
        if this is the first time it has seen the product.
    current_quantity: the real quantity read from stock_availables right now, or None
        if no stock_availables row was found.
    is_active, visibility: the product's active flag and visibility ("both"/"catalog"/
        "search"/"none").

    Returns a decision dict. The caller is responsible for driving any actual
    notification; this function only ever decides whether one is warranted.
    """
    if previous_quantity is None:
        return {"action": "record_only", "reason": "no prior quantity on file yet"}

    if current_quantity is None:
        return {"action": "record_only", "reason": "no stock_availables row to compare"}

    became_positive = previous_quantity <= 0 and current_quantity > 0
    if not became_positive:
        return {"action": "record_only", "reason": "not a zero to positive transition"}

    if not is_active or visibility == "none":
        return {"action": "record_only", "reason": "product is inactive or not visible"}

    return {"action": "flag_restock_alert", "reason": "active, visible product went from zero to positive stock"}


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def current_quantity(id_product, id_product_attribute=0):
    data = api_get("stock_availables", params={
        "filter[id_product]": id_product,
        "filter[id_product_attribute]": id_product_attribute,
        "display": "full",
    })
    rows = data.get("stock_availables") or []
    return int(rows[0]["quantity"]) if rows else None


def product_status(id_product):
    data = api_get(f"products/{id_product}", params={"display": "full"})
    product = data.get("product") or {}
    return str(product.get("active", "0")) == "1", product.get("visibility", "both")


def load_last_seen(path):
    try:
        with open(path) as f:
            return {int(k): v for k, v in json.load(f).items()}
    except FileNotFoundError:
        return {}


def save_last_seen(path, last_seen):
    with open(path, "w") as f:
        json.dump(last_seen, f)


def notify_restock(id_product, qty):
    # Plug in your own mailer, queue, or task tracker here.
    # This keeps the script honest about not owning your notification content.
    log.info("Restock alert needed for product %s, quantity now %s.", id_product, qty)


def run(tracked_product_ids):
    last_seen = load_last_seen(LAST_SEEN_PATH)
    flagged = 0

    for id_product in tracked_product_ids:
        previous_quantity = last_seen.get(id_product)
        quantity = current_quantity(id_product)
        is_active, visibility = product_status(id_product)

        decision = decide_restock_alert(previous_quantity, quantity, is_active, visibility)

        if decision["action"] == "flag_restock_alert":
            flagged += 1
            log.warning("Product %s: %s", id_product, decision["reason"])
            if not DRY_RUN:
                notify_restock(id_product, quantity)

        if quantity is not None:
            last_seen[id_product] = quantity

    save_last_seen(LAST_SEEN_PATH, last_seen)
    log.info("Done. %d restock(s) %s.", flagged, "to notify" if DRY_RUN else "notified")


if __name__ == "__main__":
    tracked = [int(x) for x in os.environ.get("TRACKED_PRODUCT_IDS", "").split(",") if x.strip()]
    run(tracked)
