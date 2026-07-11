"""Repair PrestaShop products left with a dangling id_category_default after a
category deletion.

DeleteCategoryHandler only reassigns a product's categories when the deletion
would leave it with zero categories at all. It never checks whether the
deleted category was that product's default while the product still has
other valid categories, so id_category_default keeps pointing at a category
id that no longer exists in ps_category (PrestaShop/PrestaShop issue #30219,
and related issues #28016 and #9811).

This script builds the set of valid category ids, walks every product, and
runs a pure decision function that picks a replacement default from the
product's own remaining valid categories, falling back to the shop's root
category. It logs every proposed change. A corrective PUT that resends the
full product body is only sent when DRY_RUN=false.

Guide: https://www.allanninal.dev/prestashop/product-missing-default-category-after-deletion/

Run on a schedule, or right after cleaning up the category tree. Safe to run
again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_default_category")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
PRESTASHOP_WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
FALLBACK_ROOT_CATEGORY_ID = int(os.environ.get("FALLBACK_ROOT_CATEGORY_ID", "2"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def choose_valid_default_category(product_id, current_default_id, associated_category_ids,
                                   valid_category_ids, fallback_root_id=2):
    """Pure decision function, no I/O.

    product_id: int
    current_default_id: int, the product's current id_category_default
    associated_category_ids: list[int], the product's full category list
    valid_category_ids: set[int], every category id that still exists
    fallback_root_id: int, used only when the product has no valid
        categories of its own left

    Returns a dict describing what to do. action is "none" when the current
    default is already valid, "reassign" when a safe replacement was found,
    or "flag_manual" when no valid category exists to fall back to.
    """
    if current_default_id in valid_category_ids:
        return {"id_product": product_id, "action": "none", "new_default": current_default_id}

    candidates = [
        cid for cid in associated_category_ids
        if cid in valid_category_ids and cid != current_default_id
    ]
    if candidates:
        new_default = max(candidates)
    else:
        new_default = fallback_root_id if fallback_root_id in valid_category_ids else None

    return {
        "id_product": product_id,
        "action": "reassign" if new_default else "flag_manual",
        "old_default": current_default_id,
        "new_default": new_default,
    }


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def api_put(path, resource_key, body):
    r = requests.put(
        f"{PRESTASHOP_URL}/api/{path}",
        params={"output_format": "JSON"}, auth=AUTH,
        json={resource_key: body}, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def all_category_ids(page_size=100):
    ids, offset = set(), 0
    while True:
        data = api_get("categories", params={"display": "full", "limit": f"{offset},{page_size}"})
        rows = data.get("categories") or []
        if not rows:
            return ids
        ids.update(int(row["id"]) for row in rows)
        offset += page_size


def all_products(page_size=100):
    offset = 0
    while True:
        data = api_get("products", params={"display": "full", "limit": f"{offset},{page_size}"})
        rows = data.get("products") or []
        if not rows:
            return
        for row in rows:
            yield row
        offset += page_size


def associated_category_ids(product):
    categories = ((product.get("associations") or {}).get("categories") or {}).get("category") or []
    return [int(row["id"]) for row in categories]


def repair_product_default_category(product_id, new_default_id):
    data = api_get(f"products/{product_id}")
    product = data["product"]
    product["id_category_default"] = new_default_id

    categories = product.setdefault("associations", {}).setdefault("categories", {})
    rows = categories.setdefault("category", [])
    if not any(int(row["id"]) == new_default_id for row in rows):
        rows.append({"id": new_default_id})

    return api_put(f"products/{product_id}", "product", product)


def run():
    valid_category_ids = all_category_ids()
    reassigned = 0
    flagged = 0
    for product in all_products():
        product_id = int(product["id"])
        current_default_id = int(product.get("id_category_default") or 0)
        decision = choose_valid_default_category(
            product_id, current_default_id, associated_category_ids(product),
            valid_category_ids, FALLBACK_ROOT_CATEGORY_ID,
        )
        if decision["action"] == "none":
            continue
        if decision["action"] == "flag_manual":
            flagged += 1
            log.warning("Product id=%s has no valid category to fall back to. Needs manual review.", product_id)
            continue

        log.info(
            "Product id=%s old id_category_default=%s new id_category_default=%s. %s",
            product_id, decision["old_default"], decision["new_default"],
            "would reassign" if DRY_RUN else "reassigning",
        )
        if not DRY_RUN:
            repair_product_default_category(product_id, decision["new_default"])
        reassigned += 1
    log.info("Done. %d product(s) %s, %d flagged for manual review.",
              reassigned, "to reassign" if DRY_RUN else "reassigned", flagged)


if __name__ == "__main__":
    run()
