"""Detect and repair PrestaShop products that disappear days after API creation.

Creating a product through the webservice API inserts the core Product object, but
skips several side effects the back office Save form normally does: position_in_category
in ps_category_product is left invalid (it is read only and server computed, the API
cannot set it), the product never reaches ps_search_index, and active, visibility, and
id_category_default are frequently left at defaults because they were optional fields
the caller forgot to send. The product row survives, but category listing, search, and
related products queries filter on those missing pieces, so the product quietly drops
out of navigation once cache expires or a reindex runs (PrestaShop/PrestaShop issues
#36129, #15317, #28586, #28409, #11682).

This script polls each product back with a full field GET, cross-checks its default
category's own product associations and its stock, and runs a pure decision function
that flags products at risk. The only sanctioned write (when DRY_RUN=false) is a
corrective PUT that resends the full product body with explicit active, visibility,
id_category_default, and associations.categories, mirroring a back office Save. This
forces PrestaShop to rewrite the category_product row, including its position. Search
index rebuilding is not exposed over the webservice API, so that step is only reported
to a human or an ops job, never triggered here.

Guide: https://www.allanninal.dev/prestashop/products-disappear-days-after-api-creation/

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_and_repair_delisted_products")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
PRESTASHOP_WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def is_product_at_risk_of_delisting(active, visibility, id_category_default,
                                      category_ids, stock_quantity, out_of_stock):
    """Pure decision function, no I/O.

    active: the product's "active" field, as the string the API returns ("0" or "1").
    visibility: "both", "catalog", "search", or "none".
    id_category_default: the product's default category id.
    category_ids: list of category ids from associations.categories.
    stock_quantity: current stock_availables.quantity.
    out_of_stock: stock_availables.out_of_stock (0 deny, 1 allow, 2 use default policy
        as configured; treated here as deny for the at-risk check).

    Returns (is_at_risk, reasons). Used both to detect at-risk products from a plain
    GET, and to check whether a corrective PUT payload is now complete enough to be
    considered safe, without ever touching the network.
    """
    reasons = []

    if active != "1":
        reasons.append("active is not \"1\"")
    if visibility not in ("both", "catalog"):
        reasons.append("visibility is not storefront visible")
    if id_category_default == 0:
        reasons.append("id_category_default is 0")
    if not category_ids:
        reasons.append("associations.categories is empty")
    elif id_category_default not in category_ids:
        reasons.append("id_category_default is not in associations.categories")
    if stock_quantity <= 0 and out_of_stock == 2:
        reasons.append("out of stock and denying orders")

    return (len(reasons) > 0, reasons)


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


def list_recent_product_ids(min_id, max_id, limit=100):
    data = api_get("products", params={
        "filter[id]": f"[{min_id},{max_id}]",
        "display": "[id,active,visibility,id_category_default]",
        "limit": limit,
    })
    products = data.get("products") or []
    return [int(p["id"]) for p in products]


def get_product(id_product):
    data = api_get(f"products/{id_product}", params={"display": "full"})
    return data.get("product")


def category_product_ids(id_category):
    data = api_get(f"categories/{id_category}", params={"display": "full"})
    category = data.get("category") or {}
    products = ((category.get("associations") or {}).get("products") or {}).get("product") or []
    return {int(p["id"]) for p in products}


def stock_available_for(id_product, id_product_attribute=0):
    data = api_get("stock_availables", params={
        "filter[id_product]": id_product,
        "filter[id_product_attribute]": id_product_attribute,
        "display": "full",
    })
    rows = data.get("stock_availables") or []
    return rows[0] if rows else None


def category_ids_from_product(product):
    cats = ((product.get("associations") or {}).get("categories") or {}).get("category") or []
    return [int(c["id"]) for c in cats]


def build_corrective_payload(product, id_category_default, category_ids):
    body = dict(product)
    body["active"] = "1"
    body["visibility"] = "both"
    body["id_category_default"] = id_category_default
    body["associations"] = dict(body.get("associations") or {})
    body["associations"]["categories"] = {
        "category": [{"id": cid} for cid in sorted(set(category_ids) | {id_category_default})]
    }
    return body


def repair_product(id_product, payload):
    return api_put(f"products/{id_product}", "product", payload)


def run():
    min_id = int(os.environ.get("SCAN_MIN_ID", "1"))
    max_id = int(os.environ.get("SCAN_MAX_ID", "100"))

    flagged = 0
    repaired = 0

    for id_product in list_recent_product_ids(min_id, max_id):
        product = get_product(id_product)
        if not product:
            continue

        active = str(product.get("active", "0"))
        visibility = product.get("visibility", "both")
        id_category_default = int(product.get("id_category_default", 0))
        category_ids = category_ids_from_product(product)

        row = stock_available_for(id_product)
        stock_quantity = int(row["quantity"]) if row else 0
        out_of_stock = int(row["out_of_stock"]) if row else 0

        at_risk, reasons = is_product_at_risk_of_delisting(
            active, visibility, id_category_default, category_ids, stock_quantity, out_of_stock
        )

        if not at_risk:
            continue

        flagged += 1
        log.warning("Product %s at risk of delisting: %s", id_product, "; ".join(reasons))

        if id_category_default:
            present = id_product in category_product_ids(id_category_default)
            if not present:
                log.warning(
                    "Product %s is missing from its default category %s associations.products.",
                    id_product, id_category_default,
                )

        if DRY_RUN:
            log.info("Dry run: would PUT corrective payload for product %s.", id_product)
            continue

        payload = build_corrective_payload(
            product,
            id_category_default or int(os.environ.get("FALLBACK_CATEGORY_ID", "2")),
            category_ids,
        )
        repair_product(id_product, payload)
        repaired += 1
        log.info(
            "Repaired product %s. Flagging for manual confirmation and for a human or cron "
            "to run the search index rebuild (not exposed over the webservice API).",
            id_product,
        )

    log.info("Done. %d product(s) flagged, %d repaired.", flagged, repaired)


if __name__ == "__main__":
    run()
