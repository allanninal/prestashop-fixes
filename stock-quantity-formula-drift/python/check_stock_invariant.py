"""Detect PrestaShop stock rows where physical, reserved, and virtual quantity disagree.

PrestaShop's StockAvailable model stores three numbers per product or combination that
should always reconcile: physical_quantity (units on the shelf), reserved_quantity (units
allocated to unshipped or unpaid orders), and quantity (the virtual sellable quantity,
physical minus reserved). The core only maintains that invariant through specific code
paths keyed off order_states flags, and documented core bugs plus direct writes from
modules, CSV import, or the webservice let the three fields drift apart.

This script recomputes the expected reserved quantity by walking open orders for each
product, compares it against the stored stock_availables row, and flags any mismatch.
Because physical_quantity and reserved_quantity are core-managed and read-only by
convention, the only sanctioned write (when DRY_RUN=false) is to stock_availables.quantity,
set to physical_quantity minus the recomputed reserved quantity. reserved_quantity and
physical_quantity are never written; a human is notified to re-trigger the correct
order_histories transition or run a back-office stock regularization.

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_stock_invariant")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
PRESTASHOP_WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")

# Orders in a non-final reserving state (not logable/paid yet, and not shipped) still
# hold their product_quantity as reserved stock. A state that is both paid and shipped,
# or explicitly logable as a final delivered/refused/cancelled state, no longer reserves.
NON_RESERVING_WHEN = {"shipped", "paid"}


def checkStockInvariant(stock_row, computed_reserved_quantity):
    """Pure decision function, no I/O.

    stock_row: {quantity, physicalQuantity, reservedQuantity}
    computed_reserved_quantity: recomputed by walking open orders

    Returns {inSync, formulaViolation, reservedMismatch, expectedQuantity}.
    """
    formula_violation = stock_row["physicalQuantity"] != stock_row["quantity"] + stock_row["reservedQuantity"]
    reserved_mismatch = stock_row["reservedQuantity"] != computed_reserved_quantity
    expected_quantity = stock_row["physicalQuantity"] - computed_reserved_quantity
    in_sync = not formula_violation and not reserved_mismatch
    return {
        "inSync": in_sync,
        "formulaViolation": formula_violation,
        "reservedMismatch": reserved_mismatch,
        "expectedQuantity": expected_quantity,
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
        params={"output_format": "JSON"},
        auth=AUTH,
        json={resource_key: body},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def order_state_is_reserving(id_state, state_cache):
    """A state still reserves stock unless it is both paid and shipped."""
    if id_state in state_cache:
        return state_cache[id_state]
    data = api_get(f"order_states/{id_state}")
    state = data.get("order_state", {})
    paid = str(state.get("paid", "0")) == "1"
    shipped = str(state.get("shipped", "0")) == "1"
    reserving = not (paid and shipped)
    state_cache[id_state] = reserving
    return reserving


def current_state_for_order(id_order):
    data = api_get("order_histories", params={
        "filter[id_order]": id_order,
        "display": "full",
        "sort": "date_add_DESC",
        "limit": "1",
    })
    histories = data.get("order_histories") or []
    if not histories:
        return None
    return histories[0].get("id_order_state")


def compute_reserved_quantity(id_product, id_product_attribute, state_cache):
    """Walk open orders for a product/combination and sum reserved units."""
    filters = {
        "filter[product_id]": id_product,
        "display": "full",
    }
    data = api_get("order_details", params=filters)
    details = data.get("order_details") or []
    reserved = 0
    for line in details:
        line_attribute = line.get("product_attribute_id")
        if id_product_attribute is not None and str(line_attribute) != str(id_product_attribute):
            continue
        id_order = line.get("id_order")
        id_state = current_state_for_order(id_order)
        if id_state is None:
            continue
        if order_state_is_reserving(id_state, state_cache):
            reserved += int(line.get("product_quantity", 0))
    return reserved


def stock_available_rows(id_product):
    data = api_get("stock_availables", params={
        "filter[id_product]": id_product,
        "display": "full",
    })
    return data.get("stock_availables") or []


def repair_quantity(stock_row_raw, expected_quantity):
    body = {
        "id": stock_row_raw["id"],
        "id_product": stock_row_raw["id_product"],
        "id_product_attribute": stock_row_raw["id_product_attribute"],
        "id_shop": stock_row_raw.get("id_shop", "1"),
        "quantity": expected_quantity,
        "depends_on_stock": stock_row_raw.get("depends_on_stock", "0"),
        "out_of_stock": stock_row_raw.get("out_of_stock", "2"),
    }
    return api_put(f"stock_availables/{stock_row_raw['id']}", "stock_available", body)


def run(product_ids):
    state_cache = {}
    flagged = 0
    for id_product in product_ids:
        for raw in stock_available_rows(id_product):
            id_product_attribute = raw.get("id_product_attribute")
            stock_row = {
                "quantity": int(raw["quantity"]),
                "physicalQuantity": int(raw["physical_quantity"]),
                "reservedQuantity": int(raw["reserved_quantity"]),
            }
            computed_reserved = compute_reserved_quantity(id_product, id_product_attribute, state_cache)
            result = checkStockInvariant(stock_row, computed_reserved)
            if result["inSync"]:
                continue
            flagged += 1
            log.warning(
                "Product %s attribute %s out of sync. stored quantity=%s physical=%s reserved=%s "
                "computed_reserved=%s expected_quantity=%s formulaViolation=%s reservedMismatch=%s",
                id_product, id_product_attribute, stock_row["quantity"], stock_row["physicalQuantity"],
                stock_row["reservedQuantity"], computed_reserved, result["expectedQuantity"],
                result["formulaViolation"], result["reservedMismatch"],
            )
            if not DRY_RUN:
                repair_quantity(raw, result["expectedQuantity"])
                log.info(
                    "Wrote stock_availables/%s quantity=%s. reserved_quantity and physical_quantity left "
                    "untouched; re-trigger the correct order_histories transition or run a back-office "
                    "stock regularization to fix the underlying drift.",
                    raw["id"], result["expectedQuantity"],
                )
    log.info("Done. %d stock row(s) %s.", flagged, "flagged" if DRY_RUN else "flagged and repaired")


if __name__ == "__main__":
    product_ids_env = os.environ.get("PRODUCT_IDS", "")
    ids = [p.strip() for p in product_ids_env.split(",") if p.strip()]
    if not ids:
        log.error("Set PRODUCT_IDS to a comma separated list of id_product values to check.")
    else:
        run(ids)
