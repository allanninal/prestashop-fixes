"""Find and remove orphaned PrestaShop stock_available rows left behind
after a product combination is deleted.

There is no enforced cascade between combinations (product_attribute) and
stock_available, so deleting a combination through the Back Office or the
combinations webservice resource can leave its stock row behind. The Back
Office sums quantity across every stock_available row tied to a product, so
an orphan row with nonzero quantity silently inflates the displayed total
stock. This lists live combinations and all stock rows for a product, finds
rows whose id_product_attribute matches no live combination, and deletes
them only after re-confirming on a fresh fetch immediately beforehand.
Safe to run again and again.

Guide: https://www.allanninal.dev/prestashop/orphaned-stock-rows-after-combination-delete/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("orphaned_stock_rows")

BASE_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
PRODUCT_IDS = [int(p) for p in os.environ.get("PRODUCT_IDS", "").split(",") if p.strip()]


def api_get(path, params):
    params = dict(params)
    params["output_format"] = "JSON"
    r = requests.get(f"{BASE_URL}/api/{path}", params=params, auth=(WS_KEY, ""), timeout=30)
    r.raise_for_status()
    return r.json()


def live_combinations(id_product):
    data = api_get("combinations", {"display": "full", "filter[id_product]": id_product})
    return data.get("combinations") or []


def stock_rows_for_product(id_product):
    data = api_get("stock_availables", {"display": "full", "filter[id_product]": id_product})
    rows = data.get("stock_availables") or []
    return [
        {
            "id": int(r["id"]),
            "id_product_attribute": int(r.get("id_product_attribute") or 0),
            "quantity": int(r.get("quantity") or 0),
            "out_of_stock": int(r.get("out_of_stock") or 0),
            "id_shop": int(r.get("id_shop") or 0),
        }
        for r in rows
    ]


def find_orphan_stock_rows(combinations, stock_rows):
    """Pure decision logic, no I/O.

    combinations: list of dicts from GET /api/combinations?filter[id_product]=X
                  (each with at least "id").
    stock_rows: list of dicts from GET /api/stock_availables?filter[id_product]=X
                (each with "id", "id_product_attribute", "quantity", "out_of_stock").

    Returns the stock rows whose id_product_attribute matches no live
    combination and is not 0 (0 is the base product's own stock row, which
    always survives regardless of combinations).
    """
    live_ids = {0} | {int(c["id"]) for c in combinations}
    return [row for row in stock_rows if int(row["id_product_attribute"]) not in live_ids]


def delete_stock_row(id_stock_available):
    r = requests.delete(
        f"{BASE_URL}/api/stock_availables/{id_stock_available}",
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()


def run():
    total_orphan_quantity = 0
    removed = 0
    for id_product in PRODUCT_IDS:
        combinations = live_combinations(id_product)
        stock_rows = stock_rows_for_product(id_product)
        orphans = find_orphan_stock_rows(combinations, stock_rows)

        for orphan in orphans:
            total_orphan_quantity += orphan["quantity"]
            log.warning(
                "Product %s orphan stock row id=%s id_product_attribute=%s quantity=%s id_shop=%s (%s)",
                id_product, orphan["id"], orphan["id_product_attribute"],
                orphan["quantity"], orphan["id_shop"],
                "would delete" if DRY_RUN else "deleting",
            )
            if not DRY_RUN:
                # Re-fetch and re-diff right before deleting, to avoid a race
                # with a combination created between detection and repair.
                fresh_combinations = live_combinations(id_product)
                fresh_rows = stock_rows_for_product(id_product)
                still_orphan_ids = {o["id"] for o in find_orphan_stock_rows(fresh_combinations, fresh_rows)}
                if orphan["id"] in still_orphan_ids:
                    delete_stock_row(orphan["id"])
                    removed += 1
            else:
                removed += 1

    log.info(
        "Done. %d orphan row(s) %s, %d unit(s) of orphaned quantity found.",
        removed, "to delete" if DRY_RUN else "deleted", total_orphan_quantity,
    )


if __name__ == "__main__":
    run()
