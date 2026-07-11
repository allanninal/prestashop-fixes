"""Find PrestaShop stock_available rows that went negative from an out of stock order,
and safely clamp only the true defects back to zero.

Root cause: PrestaShop lets a product be sold with zero stock whenever out_of_stock
allows ordering (0=deny, 1=allow/backorder, 2=use the global PS_ORDER_OUT_OF_STOCK
default), or when depends_on_stock is 0 for a pack or virtual product. When the order
is validated, StockAvailable::updateQuantity() subtracts the ordered amount from
ps_stock_available.quantity unconditionally, without checking whether stock is
already at zero, so quantity can go negative.

A negative quantity on a pack or virtual product (depends_on_stock = 0) is expected
and benign, since that row is not really stock-tracked. Only rows with
depends_on_stock = 1, a simple product that is supposed to be stock-tracked, are a
real oversell defect.

This script is a Reconciler, not an auto fixer: DRY_RUN defaults to true and only
reports. When DRY_RUN is false and an operator has confirmed the list, it clamps
only the quantity field to 0 on the flagged rows, and logs the old and new quantity
for every change. It never touches out_of_stock or depends_on_stock. Safe to run
again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_negative_stock")

BASE_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def api_get(path, params=None):
    """GET a Webservice resource as JSON, authenticating with the key as the
    HTTP Basic username and a blank password."""
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{BASE_URL}/api/{path}", params=params, auth=(WS_KEY, ""), timeout=30)
    r.raise_for_status()
    return r.json()


def api_put(path, body):
    """PUT a full resource body back to the Webservice API as JSON."""
    r = requests.put(
        f"{BASE_URL}/api/{path}",
        params={"output_format": "JSON"},
        json=body,
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def decide_stock_reconciliation(quantity, depends_on_stock, out_of_stock, dry_run):
    """Pure decision logic, no I/O.

    Returns {"needs_fix": bool, "new_quantity": int|None, "reason": str}.

    - quantity >= 0                       -> needs_fix=False, reason='not negative'
    - depends_on_stock != 1 (and negative) -> needs_fix=False, benign pack/virtual row
    - quantity < 0 and depends_on_stock == 1 -> needs_fix=True, new_quantity is 0
      unless dry_run, in which case it is None (nothing is written yet).
    """
    if quantity >= 0:
        return {"needs_fix": False, "new_quantity": None, "reason": "not negative"}
    if depends_on_stock != 1:
        return {
            "needs_fix": False,
            "new_quantity": None,
            "reason": "not stock-tracked (pack/virtual/depends_on_stock=0), negative value expected/benign",
        }
    return {
        "needs_fix": True,
        "new_quantity": None if dry_run else 0,
        "reason": "negative tracked stock from oversell; clamp to zero",
    }


def negative_stock_rows():
    """Pull candidate stock_available rows with quantity < 0.

    Tries the webservice range filter first (filter[quantity]=[-1000,-1]). If that
    returns nothing (some versions do not support range filtering on this field),
    falls back to paging through up to 1000 rows and filtering client side.
    """
    data = api_get("stock_availables", {
        "display": "full",
        "filter[quantity]": "[-1000,-1]",
    })
    rows = data.get("stock_availables") or []
    if not rows:
        data = api_get("stock_availables", {"display": "full", "limit": "0,1000"})
        rows = [r for r in (data.get("stock_availables") or []) if int(r.get("quantity", 0)) < 0]
    return rows


def clamp_to_zero(row):
    """PUT the row back with quantity clamped to 0. Every other field, including
    out_of_stock and depends_on_stock, is sent unchanged."""
    body = {
        "stock_available": {
            "id": row["id"],
            "id_product": row["id_product"],
            "id_product_attribute": row["id_product_attribute"],
            "quantity": 0,
            "depends_on_stock": row["depends_on_stock"],
            "out_of_stock": row["out_of_stock"],
        }
    }
    return api_put(f"stock_availables/{row['id']}", body)


def run():
    flagged = 0
    for row in negative_stock_rows():
        quantity = int(row.get("quantity", 0))
        depends_on_stock = int(row.get("depends_on_stock", 0))
        out_of_stock = int(row.get("out_of_stock", 0))
        decision = decide_stock_reconciliation(quantity, depends_on_stock, out_of_stock, DRY_RUN)
        if not decision["needs_fix"]:
            continue
        old_quantity = quantity
        log.warning(
            "stock_available %s (product %s) quantity=%s -> %s. %s",
            row["id"], row.get("id_product"), old_quantity,
            "0 (dry run)" if DRY_RUN else 0, decision["reason"],
        )
        if not DRY_RUN:
            clamp_to_zero(row)
            log.info("stock_available %s fixed: %s -> 0", row["id"], old_quantity)
        flagged += 1
    log.info("Done. %d row(s) %s.", flagged, "to clamp" if DRY_RUN else "clamped to zero")


if __name__ == "__main__":
    run()
