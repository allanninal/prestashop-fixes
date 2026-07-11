"""Find PrestaShop combinations that remain linked to a shop after the parent
product was removed from that shop, in multistore mode.

A product's shop association lives in product_shop. A combination's per-shop
presence lives in a separate table, product_attribute_shop. Removing a shop
from a product (unchecking it in the Shops association panel, or through
Product V2) only cleans up product_shop. Core does not cascade that removal
to the combination's product_attribute_shop rows, a documented bug
(PrestaShop/PrestaShop#30751). This lists active shops, reads the product's
own shop associations, lists its combinations, and checks each combination
against every shop it should no longer belong to. There is no webservice
route to delete a single product_attribute_shop row, so this script only
reports the orphaned (id_product, id_product_attribute, id_shop) tuples for
a human or database admin to review. DRY_RUN defaults to true and the
script never writes. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("orphaned_combination_shops")

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


def active_shop_ids():
    data = api_get("shops", {"display": "full"})
    return {int(s["id"]) for s in (data.get("shops") or [])}


def product_shop_ids(id_product):
    data = api_get(f"products/{id_product}", {"display": "full"})
    shops = ((data.get("product") or {}).get("associations", {}) or {}).get("shops") or []
    return {int(s["id"]) for s in shops}


def combinations_for_product(id_product):
    data = api_get("combinations", {"display": "full", "filter[id_product]": id_product, "limit": 0})
    rows = data.get("combinations") or []
    return [int(r["id"]) for r in rows]


def combination_resolves_for_shop(id_product_attribute, id_shop):
    try:
        data = api_get(f"combinations/{id_product_attribute}", {"display": "full", "id_shop": id_shop})
    except requests.HTTPError:
        return False
    return bool(data.get("combination"))


def has_stock_row(id_product, id_product_attribute, id_shop):
    data = api_get("stock_availables", {
        "display": "full",
        "filter[id_product]": id_product,
        "filter[id_product_attribute]": id_product_attribute,
        "filter[id_shop]": id_shop,
    })
    return bool(data.get("stock_availables"))


def find_orphaned_combination_shops(product_shop_ids, active_shop_ids, combination_shop_rows):
    orphans = []
    for row in combination_shop_rows:
        id_shop = row["id_shop"]
        if id_shop not in active_shop_ids:
            orphans.append({**row, "reason": "shop_inactive"})
        elif id_shop not in product_shop_ids:
            orphans.append({**row, "reason": "shop_unassigned_from_product"})
    return orphans


def run():
    all_active = active_shop_ids()
    reported = 0
    for id_product in PRODUCT_IDS:
        prod_shops = product_shop_ids(id_product)
        combo_ids = combinations_for_product(id_product)
        # Shops worth probing: every active shop the product itself is not
        # associated with. This covers the documented removal gap directly
        # (PrestaShop/PrestaShop#30751).
        shops_to_check = all_active - prod_shops

        combination_shop_rows = []
        for id_product_attribute in combo_ids:
            for id_shop in shops_to_check:
                if combination_resolves_for_shop(id_product_attribute, id_shop):
                    combination_shop_rows.append({
                        "id_product_attribute": id_product_attribute,
                        "id_shop": id_shop,
                    })

        orphans = find_orphaned_combination_shops(prod_shops, all_active, combination_shop_rows)
        for orphan in orphans:
            has_stock = has_stock_row(id_product, orphan["id_product_attribute"], orphan["id_shop"])
            log.warning(
                "Product %s combination %s orphaned for shop %s (%s), stock row present: %s",
                id_product, orphan["id_product_attribute"], orphan["id_shop"],
                orphan["reason"], has_stock,
            )
            reported += 1

    log.info("Done. %d orphaned combination-shop tuple(s) found. Report only, nothing was written.", reported)


if __name__ == "__main__":
    run()
