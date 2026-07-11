"""Detect and repair PrestaShop products whose webservice quantity is stuck at zero.

Since PrestaShop 1.5, physical stock lives in stock_availables, keyed by id_product
(and id_product_attribute for combinations), not in the products table. The webservice
products resource still exposes a legacy quantity field for backward compatibility, but
it was never wired to stock_availables.quantity, so GET always returns 0 and PUT/POST
silently no-op on it (PrestaShop/PrestaShop GitHub issue #18953).

This script lists products, ignores their bogus quantity field entirely, fetches the
real stock_availables row for each one, and flags active, visible products whose real
quantity is unexpectedly zero or negative. The only sanctioned write (when DRY_RUN=false
and a target quantity is known) is a PATCH to the specific stock_availables/{id}
resource. products.quantity is never written; it is a no-op field. Ambiguous cases are
reported for human reconciliation rather than auto-corrected.

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("sync_stock_quantity")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def decide_quantity_sync(product_quantity_field, stock_available_quantity,
                          is_active, visibility, dry_run,
                          expected_positive=False, target_quantity=None):
    """Pure decision function, no I/O.

    product_quantity_field: the legacy products.quantity value (always 0, never trusted).
    stock_available_quantity: the real quantity from stock_availables, or None if no row.
    is_active, visibility: the product's active flag and visibility ("both"/"catalog"/
        "search"/"none").
    dry_run: whether writes are currently disabled.
    expected_positive: caller's signal that this product should currently have stock
        (e.g. a known restock, or a real inventory feed reporting units on hand).
    target_quantity: the corrected quantity to write, if known.

    Returns a decision dict describing what to do. All HTTP calls happen in the caller.
    """
    # products.quantity is a legacy, unwired field and is never the comparison source.
    del product_quantity_field

    if stock_available_quantity is None:
        return {
            "status": "ignore_legacy_field",
            "action": "flag",
            "reason": "no stock_availables row found for this product",
            "target_quantity": None,
        }

    needs_repair = (
        is_active and visibility != "none"
        and stock_available_quantity <= 0
        and expected_positive
    )

    if not needs_repair:
        return {
            "status": "ignore_legacy_field",
            "action": "none",
            "reason": "real stock_availables quantity looks fine",
            "target_quantity": None,
        }

    dry_run_safe_to_write = (not dry_run) and target_quantity is not None
    if dry_run_safe_to_write:
        return {
            "status": "ignore_legacy_field",
            "action": "patch_stock_available",
            "reason": "active, visible product has non-positive real stock",
            "target_quantity": target_quantity,
        }

    return {
        "status": "ignore_legacy_field",
        "action": "flag",
        "reason": "discrepancy needs human reconciliation before any write",
        "target_quantity": target_quantity,
    }


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def api_patch(path, resource_key, body):
    r = requests.patch(
        f"{PRESTASHOP_URL}/api/{path}",
        params={"output_format": "JSON"},
        auth=AUTH,
        json={resource_key: body},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def list_products(limit=100):
    data = api_get("products", params={"display": "full", "limit": limit})
    return data.get("products") or []


def stock_available_row(id_product, id_product_attribute=0):
    data = api_get("stock_availables", params={
        "filter[id_product]": id_product,
        "filter[id_product_attribute]": id_product_attribute,
        "display": "full",
    })
    rows = data.get("stock_availables") or []
    return rows[0] if rows else None


def repair_stock_available(id_stock_available, id_product, id_product_attribute, target_quantity):
    body = {
        "id": id_stock_available,
        "id_product": id_product,
        "id_product_attribute": id_product_attribute,
        "quantity": target_quantity,
    }
    return api_patch(f"stock_availables/{id_stock_available}", "stock_available", body)


def run():
    flagged = 0
    repaired = 0
    for product in list_products():
        id_product = product.get("id")
        is_active = str(product.get("active", "0")) == "1"
        visibility = product.get("visibility", "both")
        legacy_quantity = product.get("quantity")

        row = stock_available_row(id_product)
        real_quantity = int(row["quantity"]) if row else None

        decision = decide_quantity_sync(
            product_quantity_field=legacy_quantity,
            stock_available_quantity=real_quantity,
            is_active=is_active,
            visibility=visibility,
            dry_run=DRY_RUN,
        )

        if decision["action"] == "none":
            continue

        flagged += 1
        log.warning(
            "Product %s id_stock_available=%s legacy products.quantity=%s (ignored) "
            "real stock_availables.quantity=%s action=%s reason=%s",
            id_product, row["id"] if row else None, legacy_quantity, real_quantity,
            decision["action"], decision["reason"],
        )

        if decision["action"] == "patch_stock_available" and row and not DRY_RUN:
            repair_stock_available(row["id"], id_product, row.get("id_product_attribute", 0),
                                     decision["target_quantity"])
            repaired += 1
            log.info("Patched stock_availables/%s quantity=%s.", row["id"], decision["target_quantity"])

    log.info("Done. %d row(s) flagged, %d repaired.", flagged, repaired)


if __name__ == "__main__":
    run()
