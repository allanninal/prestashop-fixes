"""Find and repair PrestaShop webservice stock updates that never reached product.quantity.

Since PrestaShop 1.5, real stock lives in stock_available.quantity, while product.quantity
on the products resource is a deprecated, denormalized column kept only for backward
compatible SQL and exports. A correct PUT to stock_availables updates the true stock but
does not always refresh that cached column, so product.quantity can sit stale or stuck at
zero. This pulls both values per product and combination, flags any pair that disagrees,
and repairs it by reposting the stock_availables row's own unchanged quantity, which forces
PrestaShop's internal Product::updateQuantity() hook to recompute the cache. Never writes
to the products resource to fix quantity. Safe to run again and again.

Guide: https://www.allanninal.dev/prestashop/webservice-stock-update-not-synced-to-product/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("webservice_stock_resync")

BASE_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def api_get(path, params):
    params = dict(params)
    params["output_format"] = "JSON"
    r = requests.get(f"{BASE_URL}/api/{path}", params=params, auth=(WS_KEY, ""), timeout=30)
    r.raise_for_status()
    return r.json()


def product_ids(limit="0,50"):
    data = api_get("products", {"display": "[id]", "limit": limit})
    products = data.get("products") or []
    return [int(p["id"]) for p in products]


def product_cached_quantity(id_product):
    data = api_get(f"products/{id_product}", {})
    product = data["product"]
    return int(product.get("quantity") or 0)


def stock_available_row(id_product, id_product_attribute=0):
    data = api_get("stock_availables", {
        "filter[id_product]": id_product,
        "filter[id_product_attribute]": id_product_attribute,
        "display": "full",
    })
    rows = data.get("stock_availables") or []
    if not rows:
        return None
    row = rows[0]
    return {
        "id_stock_available": int(row["id"]),
        "id_product": int(row["id_product"]),
        "id_product_attribute": int(row.get("id_product_attribute") or 0),
        "quantity": int(row.get("quantity") or 0),
        "out_of_stock": int(row.get("out_of_stock") or 0),
        "depends_on_stock": int(row.get("depends_on_stock") or 0),
    }


def decide_reconciliation(product_qty, stock_avail_qty, out_of_stock, depends_on_stock):
    """Pure decision. Never mutates state; caller performs the actual write/report."""
    delta = stock_avail_qty - product_qty

    if delta == 0:
        return {"status": "in_sync", "action": "none", "delta": 0}

    if product_qty == 0 and stock_avail_qty > 0:
        action = "resync_display_only" if depends_on_stock == 1 else "flag_for_review"
        return {"status": "stuck_zero", "action": action, "delta": delta}

    action = "resync_display_only" if depends_on_stock == 1 else "flag_for_review"
    return {"status": "stale_product_field", "action": action, "delta": delta}


def resync_stock_available(row):
    body = {
        "stock_available": {
            "id": row["id_stock_available"],
            "id_product": row["id_product"],
            "id_product_attribute": row["id_product_attribute"],
            "quantity": row["quantity"],
        }
    }
    r = requests.put(
        f"{BASE_URL}/api/stock_availables/{row['id_stock_available']}",
        params={"output_format": "JSON"},
        json=body,
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    checked = 0
    resynced = 0
    flagged = 0

    for id_product in product_ids():
        row = stock_available_row(id_product, 0)
        if row is None:
            continue
        product_qty = product_cached_quantity(id_product)
        checked += 1

        decision = decide_reconciliation(
            product_qty, row["quantity"], row["out_of_stock"], row["depends_on_stock"]
        )
        if decision["status"] == "in_sync":
            continue

        log.warning(
            "Product %s: product.quantity=%s stock_available.quantity=%s status=%s action=%s",
            id_product, product_qty, row["quantity"], decision["status"], decision["action"],
        )

        if decision["action"] == "resync_display_only":
            if not DRY_RUN:
                resync_stock_available(row)
            resynced += 1
        elif decision["action"] == "flag_for_review":
            flagged += 1

    log.info(
        "Done. %d product(s) checked, %d %s, %d flagged for manual review.",
        checked, resynced, "to resync" if DRY_RUN else "resynced", flagged,
    )


if __name__ == "__main__":
    run()
