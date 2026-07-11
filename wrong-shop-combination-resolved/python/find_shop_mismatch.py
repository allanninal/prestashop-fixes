"""Flag PrestaShop combinations resolved from the wrong shop context in multistore.

Combinations are shared in one product_attribute row, but price, impact, and
default-attribute fields live in the per-shop product_attribute_shop association
table. Historically the assembler code that resolves a product's combination,
ProductAssemblerCore::addMissingProductFields and cache_default_attribute lookups
such as getIdProductAttributeByIdAttributes, queried product_attribute and
product_attribute_shop without consistently filtering by id_shop, so it could
resolve an id_product_attribute that only has an association row for a sibling
shop (PrestaShop/PrestaShop issue 17573). The symptom is a combination showing
price 0 or the wrong minimal_quantity in one shop only.

This script enumerates shops, lists each shop's products, reads the resolved
combination per shop, and cross-checks it against stock_availables to learn
which shops a combination is actually associated with. A pure decision function
flags every combination whose resolved shop is not among its actual shops. It
reports by default. A guarded PUT to /api/combinations/{id} with ?id_shop= is
only logged, and only sent when DRY_RUN=false, for a confirmed missing-association
gap. It never deletes or reassigns the core product_attribute row.

Run on a schedule, or right after a multistore catalog sync. Safe to run again
and again, since it never writes unless DRY_RUN is explicitly turned off.

Guide: https://www.allanninal.dev/prestashop/wrong-shop-combination-resolved/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_shop_mismatch")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def find_shop_mismatched_combinations(shop_id, product_combinations, shop_associations_by_combination):
    """Pure decision function, no I/O, no network calls, deterministic given inputs.

    shop_id: the id_shop context the product/combination was resolved under (e.g. the
        default/resolved id_product_attribute returned while operating in this shop).
    product_combinations: list of dicts like {"id_product_attribute": int, "id_product": int,
        "price": float, "minimal_quantity": int} as resolved/returned for this shop context.
    shop_associations_by_combination: map of id_product_attribute -> set of id_shop values that
        combination is actually associated with (derived from product_attribute_shop /
        combinations API).

    Returns a list of flagged dicts: {"id_product_attribute": int, "id_product": int,
        "resolved_in_shop": shop_id, "actual_shops": sorted list, "reason": str}
    for every combination whose resolved shop_id is not among its actual associated shops.
    """
    flagged = []
    for combo in product_combinations:
        id_product_attribute = combo["id_product_attribute"]
        actual_shops = shop_associations_by_combination.get(id_product_attribute, set())
        if shop_id not in actual_shops:
            flagged.append({
                "id_product_attribute": id_product_attribute,
                "id_product": combo["id_product"],
                "resolved_in_shop": shop_id,
                "actual_shops": sorted(actual_shops),
                "reason": "resolved id_product_attribute has no product_attribute_shop association for this shop",
            })
    return flagged


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def api_put(path, resource_key, body, params):
    r = requests.put(
        f"{PRESTASHOP_URL}/api/{path}",
        params=params, auth=AUTH,
        json={resource_key: body}, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def all_shop_ids():
    data = api_get("shops", params={"display": "full"})
    rows = data.get("shops") or []
    return [int(row["id"]) for row in rows]


def products_for_shop(id_shop):
    data = api_get("products", params={"display": "full", "filter[id_shop]": id_shop})
    return data.get("products") or []


def resolved_product_for_shop(id_product, id_shop):
    data = api_get(f"products/{id_product}", params={"id_shop": id_shop, "display": "full"})
    return data.get("product") or {}


def combinations_for_product(id_product):
    data = api_get("combinations", params={"display": "full", "filter[id_product]": id_product})
    return data.get("combinations") or []


def stock_available_shops(id_product, id_product_attribute):
    data = api_get("stock_availables", params={
        "display": "full",
        "filter[id_product]": id_product,
        "filter[id_product_attribute]": id_product_attribute,
    })
    rows = data.get("stock_availables") or []
    return {int(row["id_shop"]) for row in rows if int(row.get("id_shop", 0)) > 0}


def rescope_combination_to_shop(combination, id_shop):
    # Resend the identical combination body, scoping the query string to id_shop,
    # to create the missing product_attribute_shop association. Per the Manage
    # Multishop pattern. Never deletes or reassigns the core product_attribute row.
    body = dict(combination)
    return api_put(
        f"combinations/{combination['id']}", "combination", body,
        params={"output_format": "JSON", "id_shop": id_shop},
    )


def run(confirm=False):
    flagged_total = 0
    repaired = 0
    for id_shop in all_shop_ids():
        for product in products_for_shop(id_shop):
            id_product = int(product["id"])
            resolved = resolved_product_for_shop(id_product, id_shop)
            if not resolved.get("id_default_combination"):
                continue
            combinations = combinations_for_product(id_product)
            if not combinations:
                continue
            shop_map = {}
            for combo in combinations:
                id_product_attribute = int(combo["id"])
                shop_map[id_product_attribute] = stock_available_shops(id_product, id_product_attribute)
            resolved_combo = {
                "id_product_attribute": int(resolved["id_default_combination"]),
                "id_product": id_product,
                "price": resolved.get("price"),
                "minimal_quantity": resolved.get("minimal_quantity"),
            }
            flagged = find_shop_mismatched_combinations(id_shop, [resolved_combo], shop_map)
            for item in flagged:
                flagged_total += 1
                log.warning(
                    "Product %s id_product_attribute=%s resolved_in_shop=%s actual_shops=%s",
                    item["id_product"], item["id_product_attribute"], item["resolved_in_shop"], item["actual_shops"],
                )
                if not DRY_RUN and confirm:
                    combo_body = next((c for c in combinations if int(c["id"]) == item["id_product_attribute"]), None)
                    if combo_body is not None:
                        rescope_combination_to_shop(combo_body, id_shop)
                        repaired += 1
                        log.info(
                            "Repaired id_product_attribute=%s for id_shop=%s.",
                            item["id_product_attribute"], id_shop,
                        )
    log.info("Done. %d combination(s) flagged, %d repaired.", flagged_total, repaired)


if __name__ == "__main__":
    run()
