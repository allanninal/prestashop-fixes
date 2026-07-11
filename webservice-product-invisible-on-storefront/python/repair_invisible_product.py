"""Detect and repair PrestaShop products created via webservice that are invisible
on the storefront despite showing active in the back office.

The full admin product save wires up category_product links, shop associations,
and search index rows as side effects of the whole controller save chain. The
webservice Product::add()/update() path only writes what the submitted resource
body explicitly includes. A payload that sets active=1 without an
associations.categories block carrying id_category_default, or without an
associations.shops entry, leaves the product active in product/product_shop but
with no category link and no shop association, so front-end catalog queries that
join through those tables never return it (PrestaShop/PrestaShop issues #15317
and #28409).

This script lists recently created active products with display=full, inspects
the associations block already returned, cross-checks id_category_default against
real categories, and flags or repairs the missing links. Repair merges the fix
onto the full current resource and PUTs it back, then re-GETs to confirm. A
product whose default category itself is invalid is only ever flagged, never
auto-written, since guessing a replacement category could mis-file it.

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("repair_invisible_product")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
PRESTASHOP_WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
EXPECTED_SHOP_IDS = [int(s) for s in os.environ.get("EXPECTED_SHOP_IDS", "1").split(",") if s.strip()]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def decide_product_repair(product, context):
    """Pure decision function, no I/O.

    product: {active: 0|1, visibility: "both"|"catalog"|"search"|"none",
              id_category_default: int, associations: {categories: [int], shops: [int]}}
    context: {expectedShopIds: [int], validCategoryIds: [int]}

    Returns {status: "ok"|"needs_repair"|"unrepairable", missing: [str], patch: dict|None}.
    """
    if product["active"] != 1:
        return {"status": "ok", "missing": [], "patch": None}

    missing = []
    categories = product["associations"]["categories"]
    id_category_default = product["id_category_default"]

    if len(categories) == 0:
        missing.append("categories")
    elif id_category_default not in categories:
        missing.append("id_category_default_not_in_categories")

    shops = product["associations"]["shops"]
    expected_shop_ids = context["expectedShopIds"]
    if len(shops) == 0 or not any(sid in shops for sid in expected_shop_ids):
        missing.append("shops")

    if product["visibility"] == "none":
        missing.append("visibility")

    if id_category_default not in context["validCategoryIds"]:
        missing.append("default_category_invalid")
        return {"status": "unrepairable", "missing": missing, "patch": None}

    if not missing:
        return {"status": "ok", "missing": [], "patch": None}

    patch = {}
    if "categories" in missing or "id_category_default_not_in_categories" in missing:
        patch["associations"] = {
            "categories": sorted(set(categories) | {id_category_default})
        }
    if "shops" in missing:
        patch.setdefault("associations", {})["shops"] = list(expected_shop_ids)
    if "visibility" in missing:
        patch["visibility"] = "both"

    return {"status": "needs_repair", "missing": missing, "patch": patch}


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def api_put(path, resource_key, body):
    r = requests.put(
        f"{PRESTASHOP_URL}/api/{path}",
        params={"output_format": "JSON"},
        auth=AUTH,
        json={resource_key: body},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def list_recent_active_products(date_from, date_to, limit=100):
    data = api_get("products", params={
        "display": "full",
        "filter[active]": 1,
        "filter[date_add]": f"[{date_from},{date_to}]",
        "limit": limit,
    })
    return data.get("products") or []


def category_is_valid(id_category):
    try:
        data = api_get(f"categories/{id_category}")
    except requests.HTTPError:
        return False
    category = data.get("category") or {}
    return str(category.get("active", "0")) == "1"


def get_full_product(id_product):
    data = api_get(f"products/{id_product}", params={"display": "full"})
    return data["product"]


def merge_patch_onto_resource(full_product, patch):
    merged = dict(full_product)
    if "associations" in patch:
        merged["associations"] = {**merged.get("associations", {}), **patch["associations"]}
    if "visibility" in patch:
        merged["visibility"] = patch["visibility"]
    return merged


def put_product(id_product, merged_product):
    return api_put(f"products/{id_product}", "product", merged_product)


def to_decision_shape(product):
    associations = product.get("associations") or {}
    categories = [c["id"] for c in (associations.get("categories") or {}).get("category", [])]
    shops = [s["id"] for s in (associations.get("shops") or {}).get("shop", [])]
    return {
        "active": int(product.get("active", 0)),
        "visibility": product.get("visibility", "both"),
        "id_category_default": int(product.get("id_category_default", 0)),
        "associations": {"categories": categories, "shops": shops},
    }


def run(date_from="2026-07-01", date_to="2026-07-11"):
    flagged = 0
    repaired = 0
    unrepairable = 0
    valid_category_cache = {}

    for raw_product in list_recent_active_products(date_from, date_to):
        id_product = raw_product["id"]
        product = to_decision_shape(raw_product)
        id_category_default = product["id_category_default"]

        if id_category_default not in valid_category_cache:
            valid_category_cache[id_category_default] = category_is_valid(id_category_default)
        valid_category_ids = [cid for cid, ok in valid_category_cache.items() if ok]

        decision = decide_product_repair(product, {
            "expectedShopIds": EXPECTED_SHOP_IDS,
            "validCategoryIds": valid_category_ids,
        })

        if decision["status"] == "ok":
            continue

        flagged += 1
        log.warning("Product %s status=%s missing=%s", id_product, decision["status"], decision["missing"])

        if decision["status"] == "unrepairable":
            unrepairable += 1
            log.error("Product %s has an invalid id_category_default=%s, needs a human to pick a category.",
                       id_product, id_category_default)
            continue

        if DRY_RUN:
            log.info("Dry run. Would PUT products/%s with patch=%s", id_product, decision["patch"])
            continue

        full_product = get_full_product(id_product)
        merged = merge_patch_onto_resource(full_product, decision["patch"])
        put_product(id_product, merged)

        confirm_raw = get_full_product(id_product)
        confirm = to_decision_shape(confirm_raw)
        confirm_decision = decide_product_repair(confirm, {
            "expectedShopIds": EXPECTED_SHOP_IDS,
            "validCategoryIds": valid_category_ids,
        })
        if confirm_decision["status"] == "ok":
            repaired += 1
            log.info("Repaired product %s.", id_product)
        else:
            log.error("Product %s still needs_repair after PUT, missing=%s. Not retrying silently.",
                       id_product, confirm_decision["missing"])

    log.info("Done. %d flagged, %d repaired, %d unrepairable.", flagged, repaired, unrepairable)


if __name__ == "__main__":
    run()
