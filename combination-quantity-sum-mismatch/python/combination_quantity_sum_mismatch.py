"""Detect PrestaShop combination stock quantities that do not sum to the product total.

stock_available keeps one row per (id_product, id_product_attribute, id_shop). The row
where id_product_attribute is 0 is the product-level quantity, and it is only kept equal
to the sum of the combination rows by application code such as StockAvailable::synchronizeOne,
never by a live SUM() or a database constraint. Deleting and recreating combinations, direct
SQL or ERP writes, and advanced stock management setups can all leave the two figures
disagreeing. This reports the mismatch and any orphaned stock rows left behind by deleted
combinations. It never writes a combination row, and it only writes the product-level row
when a mismatch is confirmed and DRY_RUN is off. Safe to run again and again.

Guide: https://www.allanninal.dev/prestashop/combination-quantity-sum-mismatch/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("combination_quantity_sum_mismatch")

BASE_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
SHOP_ID = int(os.environ.get("PRESTASHOP_SHOP_ID", "1"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def api_get(path, params):
    params = dict(params)
    params["output_format"] = "JSON"
    r = requests.get(f"{BASE_URL}/api/{path}", params=params, auth=(WS_KEY, ""), timeout=30)
    r.raise_for_status()
    return r.json()


def combinations_for_product(id_product):
    data = api_get("combinations", {"display": "full", "filter[id_product]": id_product})
    rows = data.get("combinations") or []
    return [{"id": int(c["id"]), "id_product": int(c["id_product"])} for c in rows]


def stock_rows_for_product(id_product):
    data = api_get("stock_availables", {"display": "full", "filter[id_product]": id_product})
    rows = data.get("stock_availables") or []
    return [
        {
            "id": int(r["id"]),
            "id_product": int(r["id_product"]),
            "id_product_attribute": int(r.get("id_product_attribute") or 0),
            "id_shop": int(r.get("id_shop") or 0),
            "quantity": int(r.get("quantity") or 0),
        }
        for r in rows
    ]


def find_stock_mismatches(product_id, combinations, stock_available_rows, shop_id):
    """Pure decision function. No network or DB calls. See the guide for the full spec."""
    rows = [
        r for r in stock_available_rows
        if r["id_shop"] == shop_id and r["id_product"] == product_id
    ]
    valid_attribute_ids = {c["id"] for c in combinations}

    product_row = next((r for r in rows if r["id_product_attribute"] == 0), None)
    product_level_quantity = product_row["quantity"] if product_row else None

    combination_rows = [r for r in rows if r["id_product_attribute"] != 0]
    orphaned_row_ids = [
        r["id"] for r in combination_rows
        if r["id_product_attribute"] not in valid_attribute_ids
    ]
    valid_combination_rows = [
        r for r in combination_rows
        if r["id_product_attribute"] in valid_attribute_ids
    ]
    combination_quantity_sum = sum(r["quantity"] for r in valid_combination_rows)

    delta = (product_level_quantity or 0) - combination_quantity_sum
    is_mismatched = len(combinations) > 0 and delta != 0

    return {
        "productId": product_id,
        "productLevelQuantity": product_level_quantity,
        "combinationQuantitySum": combination_quantity_sum,
        "delta": delta,
        "isMismatched": is_mismatched,
        "orphanedRowIds": orphaned_row_ids,
    }


def correct_product_level_quantity(product_row_id, combination_quantity_sum):
    body = {"stock_available": {"id": product_row_id, "quantity": combination_quantity_sum}}
    r = requests.put(
        f"{BASE_URL}/api/stock_availables/{product_row_id}",
        params={"output_format": "JSON"},
        json=body,
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def check_product(product_id, shop_id=SHOP_ID):
    combinations = combinations_for_product(product_id)
    rows = stock_rows_for_product(product_id)
    return find_stock_mismatches(product_id, combinations, rows, shop_id), rows


def run(product_ids):
    mismatched_count = 0
    orphan_count = 0
    for product_id in product_ids:
        report, rows = check_product(product_id)

        if report["orphanedRowIds"]:
            orphan_count += len(report["orphanedRowIds"])
            log.warning(
                "Product %s has %d orphaned stock_available row(s): %s (manual review only)",
                product_id, len(report["orphanedRowIds"]), report["orphanedRowIds"],
            )

        if not report["isMismatched"]:
            continue
        mismatched_count += 1
        log.warning(
            "Product %s mismatch: product_level=%s combination_sum=%s delta=%s (%s)",
            product_id, report["productLevelQuantity"], report["combinationQuantitySum"],
            report["delta"], "would correct" if DRY_RUN else "correcting",
        )
        if not DRY_RUN:
            product_row = next(r for r in rows if r["id_product_attribute"] == 0)
            correct_product_level_quantity(product_row["id"], report["combinationQuantitySum"])

    log.info(
        "Done. %d product(s) mismatched, %d orphaned row(s) found.",
        mismatched_count, orphan_count,
    )


if __name__ == "__main__":
    ids = [int(x) for x in os.environ.get("PRODUCT_IDS", "").split(",") if x.strip()]
    run(ids)
