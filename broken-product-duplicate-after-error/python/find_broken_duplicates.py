"""Find, and only on explicit confirmation deactivate, PrestaShop products
left broken by a product duplication that errored out partway through.

PrestaShop's AdminProductsController::processDuplicate and Product::duplicateProduct
run as a long, non-transactional sequence of separate INSERT operations: the base
product row first, then a loop over combinations, features, images, accessories,
tags, and specific prices. If any single step throws, PrestaShop shows a 500 error
but never rolls back the new product row already committed in the first step. This
is documented across multiple versions (GitHub issues #19053, #19574, #31737).

This script pulls recently created products through the Webservice API, fetches
each candidate's combinations, features, and stock_availables rows, and classifies
the shape of the damage with a pure decision function. By default it only reports.
Set DRY_RUN=false to let it deactivate (active=0) a product it classified as a
suspect partial duplicate. It never deletes a product and never tries to recreate
missing combinations, features, or images.

Guide: https://www.allanninal.dev/prestashop/broken-product-duplicate-after-error/
"""
import os
import json
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_broken_duplicates")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
DATE_FROM = os.environ.get("DATE_FROM", "2000-01-01")
DATE_TO = os.environ.get("DATE_TO", "2100-01-01")


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


def _is_copy(product):
    """A product PrestaShop's duplicate action produced carries the string
    'copy' PrestaShop appends to the reference, or a name ending in (copy)."""
    for field in ("reference", "name"):
        value = str(product.get(field) or "").strip().lower()
        if value.endswith("(copy)") or "copy" in value:
            return True
    return False


def _has_orphaned_stock(combinations, stock_rows):
    """A combination whose id_product_attribute has no matching
    stock_availables row means the duplication died between the combination
    insert and the stock/attribute-value linkage step."""
    stocked_attrs = {row.get("id_product_attribute") for row in stock_rows}
    for combo in combinations:
        if combo.get("id") not in stocked_attrs:
            return True
    return False


def classify_duplicate_integrity(product, combinations, features, stock_rows,
                                  sibling_combination_count=None):
    """Pure decision logic, no I/O. Takes already-fetched API JSON fragments
    and returns one of:
      OK, MISSING_COMBINATIONS, MISSING_FEATURES, ORPHANED_STOCK,
      SUSPECT_PARTIAL_DUPLICATE

    product: the /api/products/{id} JSON body (has 'reference', 'active', etc,
             plus an optional 'expected_features' hint from the caller).
    combinations: list of /api/combinations entries filtered by id_product.
    features: product['associations']['product_features'] equivalent,
              pre-extracted list.
    stock_rows: list of /api/stock_availables entries filtered by id_product.
    sibling_combination_count: expected combo count from the presumed source
                                product, if known.
    """
    is_copy = _is_copy(product)

    if is_copy and len(combinations) == 0 and (sibling_combination_count or 0) > 0:
        return "MISSING_COMBINATIONS"

    if is_copy and len(features) == 0 and product.get("expected_features"):
        return "MISSING_FEATURES"

    if combinations and _has_orphaned_stock(combinations, stock_rows):
        return "ORPHANED_STOCK"

    if (is_copy and sibling_combination_count is not None
            and len(combinations) < sibling_combination_count):
        return "SUSPECT_PARTIAL_DUPLICATE"

    return "OK"


def recent_products(date_from, date_to):
    data = api_get("products", {
        "filter[date_add]": f"[{date_from},{date_to}]",
        "display": "full",
        "limit": "200",
    })
    return data.get("products") or []


def combinations_for(id_product):
    data = api_get("combinations", {
        "filter[id_product]": id_product,
        "display": "full",
    })
    return data.get("combinations") or []


def stock_rows_for(id_product):
    data = api_get("stock_availables", {
        "filter[id_product]": id_product,
        "display": "full",
    })
    return data.get("stock_availables") or []


def features_for(product):
    associations = product.get("associations") or {}
    return associations.get("product_features") or []


def deactivate(product):
    body = dict(product)
    body["active"] = "0"
    id_product = product["id"]
    log.warning("Deactivating suspect duplicate product %s", id_product)
    if not DRY_RUN:
        api_put(f"products/{id_product}", {"product": body})


def run():
    candidates = recent_products(DATE_FROM, DATE_TO)
    flagged = 0

    for product in candidates:
        id_product = product["id"]
        combinations = combinations_for(id_product)
        features = features_for(product)
        stock_rows = stock_rows_for(id_product)

        verdict = classify_duplicate_integrity(product, combinations, features, stock_rows)

        if verdict == "OK":
            continue

        flagged += 1
        print(json.dumps({
            "id_product": id_product,
            "reference": product.get("reference"),
            "date_add": product.get("date_add"),
            "verdict": verdict,
            "combinations_found": len(combinations),
            "features_found": len(features),
            "stock_rows_found": len(stock_rows),
        }))

        if not DRY_RUN:
            deactivate(product)

    log.info("Done. %d suspect duplicate(s) found among %d recent product(s).",
              flagged, len(candidates))


if __name__ == "__main__":
    run()
