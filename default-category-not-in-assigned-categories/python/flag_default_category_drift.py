"""Flag PrestaShop products whose default category is not among their assigned categories.

The backend product editor writes category associations to category_product
instantly, over AJAX, the moment a merchant checks or unchecks a box, without
waiting for Save. It never re-validates id_category_default at that moment. If
the category that was the default gets unchecked, or a category is deleted
store-wide, id_category_default keeps pointing at a category the product is no
longer linked to (PrestaShop/PrestaShop issues #28016 and #30219). Catalog
import can cause the same drift when only partial category data is sent for a
row and the importer overwrites id_category_default without validating it
against the submitted categories (issue #32412).

This script pages through active products from the webservice, runs a pure
decision function that flags any product where id_category_default is not in
its associations.categories.category[] ids, and reports by default. A
corrective PUT that resends the full product body with only
id_category_default corrected is only sent when DRY_RUN=false and --auto-fix
is passed, one product id at a time, using the lowest id currently in the
associations as the deterministic replacement.

Run on a schedule, or right after a bulk category edit or import. Safe to run
again and again.

Guide: https://www.allanninal.dev/prestashop/default-category-not-in-assigned-categories/
"""
import os
import sys
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_default_category_drift")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
ROOT_CATEGORY_ID = int(os.environ.get("ROOT_CATEGORY_ID", "2"))
PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "50"))
AUTH = (PRESTASHOP_WS_KEY, "")


def find_default_category_drift(id_category_default, associated_category_ids):
    """Pure decision function, no I/O.

    id_category_default: int | str | None, the product's id_category_default
        value as read from the webservice.
    associated_category_ids: list[int | str], the ids from
        associations.categories.category[].

    Returns None when the default is fine (it is present in the associated
    ids, or there is no default to check). Returns a dict with
    id_category_default (the stale value, as int) and valid_category_ids (the
    sorted, de-duplicated associations list, as ints) when the default is not
    among them, so a human or an auto-fix step can pick a sane replacement.
    """
    valid_ids = sorted({int(x) for x in (associated_category_ids or [])})
    if id_category_default is None:
        return None
    if int(id_category_default) in valid_ids:
        return None
    return {
        "id_category_default": int(id_category_default),
        "valid_category_ids": valid_ids,
    }


def assigned_category_ids(product):
    """Extract the assigned category ids out of a product's webservice body."""
    categories = ((product.get("associations") or {}).get("categories") or {}).get("category") or []
    return [int(row["id"]) for row in categories]


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def api_put(path, resource_key, body, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.put(
        f"{PRESTASHOP_URL}/api/{path}",
        params=params, auth=AUTH,
        json={resource_key: body}, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def active_products():
    offset = 0
    while True:
        data = api_get("products", params={
            "display": "full",
            "filter[active]": 1,
            "limit": f"{offset},{PAGE_SIZE}",
        })
        rows = data.get("products") or []
        if not rows:
            return
        for row in rows:
            yield row
        offset += PAGE_SIZE


def category_still_exists(category_id):
    """Optional cross-check: a 404 confirms the deleted-category variant (issue #30219)."""
    try:
        api_get(f"categories/{category_id}")
        return True
    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 404:
            return False
        raise


def repair_default_category(product, drift):
    # Always fetch-modify-PUT the complete product body, never hand-construct
    # it, and never touch associations.categories, only id_category_default.
    replacement = drift["valid_category_ids"][0] if drift["valid_category_ids"] else ROOT_CATEGORY_ID
    body = dict(product)
    body["id_category_default"] = replacement
    api_put(f"products/{product['id']}", "product", body)
    return replacement


def run(auto_fix=False):
    flagged = 0
    repaired = 0
    for product in active_products():
        drift = find_default_category_drift(
            product.get("id_category_default"), assigned_category_ids(product),
        )
        if drift is None:
            continue
        flagged += 1
        log.warning(
            "Product id=%s id_category_default=%s (stale) valid_category_ids=%s",
            product.get("id"), drift["id_category_default"], drift["valid_category_ids"],
        )
        if not DRY_RUN and auto_fix:
            replacement = repair_default_category(product, drift)
            repaired += 1
            log.info(
                "Repaired product id=%s: id_category_default %s -> %s.",
                product.get("id"), drift["id_category_default"], replacement,
            )
    log.info("Done. %d product(s) flagged, %d repaired.", flagged, repaired)


if __name__ == "__main__":
    run(auto_fix="--auto-fix" in sys.argv)
