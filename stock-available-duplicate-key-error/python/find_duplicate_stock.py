"""Find and, if confirmed, merge duplicate PrestaShop stock_available rows.

ps_stock_available has a unique key (product_sqlstock) on id_product,
id_product_attribute, id_shop, and id_shop_group. StockAvailable::setQuantity()
selects a row for that key then decides to update or insert. Two near
simultaneous writes can both miss each other's row and both try to insert,
so the second one hits a duplicate entry error on product_sqlstock, or in
multistore installs lands as an orphan row scoped to id_shop=0/id_shop_group=0.

This script enumerates stock_availables for a product, groups them by that
same natural key, and reports any group with more than one row. It also
flags stock rows whose id_product_attribute no longer exists on the product.
By default it only reports. Set DRY_RUN=false to let it PUT the merged
keep row and DELETE the extra rows, after you confirm the quantities.

Guide: https://www.allanninal.dev/prestashop/stock-available-duplicate-key-error/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_duplicate_stock")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(
        f"{PRESTASHOP_URL}/api/{path}",
        params=params,
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def api_put(path, body):
    r = requests.put(
        f"{PRESTASHOP_URL}/api/{path}",
        params={"output_format": "JSON"},
        json=body,
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def api_delete(path):
    r = requests.delete(
        f"{PRESTASHOP_URL}/api/{path}",
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()


def natural_key(row):
    return (
        int(row["id_product"]),
        int(row["id_product_attribute"]),
        int(row["id_shop"]),
        int(row["id_shop_group"]),
    )


def find_duplicate_stock_rows(rows):
    """Group stock_availables rows by (id_product, id_product_attribute, id_shop,
    id_shop_group) and return only the groups with more than one row. Each group
    is sorted so the row with id_shop != 0 and the highest id sorts first, which
    is the keep candidate for a merge. Pure: no HTTP calls, no side effects.
    """
    groups = {}
    for row in rows:
        key = natural_key(row)
        groups.setdefault(key, []).append(row)

    duplicates = []
    for key, group in groups.items():
        if len(group) <= 1:
            continue
        ordered = sorted(
            group,
            key=lambda r: (int(r["id_shop"]) != 0, int(r["id"])),
            reverse=True,
        )
        duplicates.append(ordered)
    return duplicates


def find_orphaned_combination_rows(rows, live_ids):
    """Return stock rows whose id_product_attribute no longer exists among
    live_ids (the current combination ids on the product). A row with
    id_product_attribute == 0 is the simple-product row and is never orphaned.
    """
    orphans = []
    for row in rows:
        attr_id = int(row["id_product_attribute"])
        if attr_id != 0 and attr_id not in live_ids:
            orphans.append(row)
    return orphans


def stock_rows_for_product(id_product):
    data = api_get("stock_availables", {
        "filter[id_product]": id_product,
        "display": "full",
    })
    return data.get("stock_availables") or []


def live_combination_ids(id_product):
    data = api_get("combinations", {
        "filter[id_product]": id_product,
        "display": "full",
    })
    rows = data.get("combinations") or []
    return {int(row["id"]) for row in rows}


def merge_duplicate_group(group):
    keep, *rest = group
    quantities = [int(row["quantity"]) for row in group]
    merged_quantity = max(quantities)
    body = dict(keep)
    body["quantity"] = merged_quantity
    log.info(
        "Merging stock rows for product %s attribute %s: keep id=%s quantity %s -> %s, dropping id(s) %s",
        keep["id_product"], keep["id_product_attribute"], keep["id"],
        keep["quantity"], merged_quantity, [row["id"] for row in rest],
    )
    if not DRY_RUN:
        api_put(f"stock_availables/{keep['id']}", body)
        for row in rest:
            api_delete(f"stock_availables/{row['id']}")
    return keep["id"], merged_quantity


def run(id_product):
    rows = stock_rows_for_product(id_product)
    live_ids = live_combination_ids(id_product)

    duplicates = find_duplicate_stock_rows(rows)
    orphans = find_orphaned_combination_rows(rows, live_ids)

    for group in duplicates:
        log.warning(
            "Duplicate stock rows for key %s: %s",
            natural_key(group[0]), [row["id"] for row in group],
        )
        merge_duplicate_group(group)

    for row in orphans:
        log.warning(
            "Orphaned stock row id=%s references missing combination id_product_attribute=%s",
            row["id"], row["id_product_attribute"],
        )

    log.info(
        "Done. %d duplicate group(s), %d orphaned row(s) for product %s.",
        len(duplicates), len(orphans), id_product,
    )


if __name__ == "__main__":
    target_product = os.environ.get("TARGET_ID_PRODUCT")
    if not target_product:
        raise SystemExit("Set TARGET_ID_PRODUCT to the product id to check.")
    run(int(target_product))
