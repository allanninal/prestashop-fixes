"""Find and repair negative PrestaShop stock quantities from backorder paid orders.

PrestaShop decrements ps_stock_available.quantity at order validation without a
transactional row lock tied to the final payment confirmation. When a product allows
backorders, or stock enforcement is momentarily bypassed, concurrent checkouts or an
order passing through a backorder paid state can each subtract from an already-zero or
already-reserved line, driving quantity below zero with nothing in core to self heal it.

This pulls every negative stock_availables row, cross-references the orders and order
states that plausibly caused it, and classifies each row as no correction needed, safe
to clamp to zero, or needing a human to reconcile stock or trigger a reorder. Only the
clamp rows are ever written, and only quantity changes. Safe to run again and again.

Guide: https://www.allanninal.dev/prestashop/negative-quantity-on-backorder-orders/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("negative_quantity_backorder")

BASE_URL = os.environ.get("PRESTASHOP_URL", "https://example.test").rstrip("/")
WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "dummy_key")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def api_get(path, params):
    params = dict(params)
    params["output_format"] = "JSON"
    r = requests.get(f"{BASE_URL}/api/{path}", params=params, auth=(WS_KEY, ""), timeout=30)
    r.raise_for_status()
    return r.json()


def negative_stock_rows():
    data = api_get("stock_availables", {"display": "full", "limit": "0,1000"})
    rows = data.get("stock_availables") or []
    out = []
    for r in rows:
        quantity = int(r.get("quantity") or 0)
        if quantity >= 0:
            continue
        out.append({
            "id": int(r["id"]),
            "id_product": int(r["id_product"]),
            "id_product_attribute": int(r.get("id_product_attribute") or 0),
            "quantity": quantity,
            "out_of_stock": int(r.get("out_of_stock") or 0),
            "depends_on_stock": str(r.get("depends_on_stock")) in ("1", "true", "True"),
        })
    return out


def order_details_for_product(id_product):
    data = api_get("order_details", {"display": "full", "filter[product_id]": id_product})
    return data.get("order_details") or []


def order_by_id(id_order):
    data = api_get(f"orders/{id_order}", {"display": "full"})
    return data.get("order") or {}


def order_state_by_id(id_order_state):
    data = api_get(f"order_states/{id_order_state}", {"display": "full"})
    return data.get("order_state") or {}


def has_open_backorder_paid_order(id_product):
    """Check whether any order line for this product sits on a paid, backorder-named
    order state with a negative product_quantity, meaning real oversell demand is
    still open against this product."""
    for line in order_details_for_product(id_product):
        order = order_by_id(line["id_order"])
        state = order_state_by_id(order.get("current_state"))
        paid = str(state.get("paid")) in ("1", "true", "True")
        name = str(state.get("name") or "")
        product_quantity = int(line.get("product_quantity") or 0)
        if paid and "backorder" in name.lower() and product_quantity < 0:
            return True
    return False


def clamp_negative_stock(quantity: int, depends_on_stock: bool, out_of_stock_policy: int, has_pending_backorder_paid: bool) -> tuple:
    """
    Decide the corrected stock_availables.quantity and an action tag, given the
    current (possibly negative) quantity and the product's backorder policy.

    out_of_stock_policy: 0 = deny, 1 = allow (backorder), 2 = use global default
    Returns (new_quantity, action) where action in {"noop", "clamp_to_zero", "flag_manual_review"}.

    Decision logic:
    - If quantity >= 0: no correction needed -> (quantity, "noop").
    - If quantity < 0 and depends_on_stock is False: PrestaShop is not tracking
      this stock line for decrement purposes, so leave the number alone but
      flag it since a negative value there is meaningless -> (quantity, "flag_manual_review").
    - If quantity < 0 and out_of_stock_policy == 1 (backorders explicitly allowed)
      and there is a genuine open backorder-paid order still awaiting fulfillment:
      the negative number is an accurate signal of oversell depth, so do not
      silently zero it out (that would erase real backorder demand) -> flag it
      for a human/replenishment workflow -> (quantity, "flag_manual_review").
    - If quantity < 0 and (out_of_stock_policy == 0, i.e. backorders should have
      been denied) or there is no matching open backorder-paid order to justify
      the deficit: this is drift/corruption (e.g. from the race-condition bug in
      PrestaShop #18700/#27631), so normalize it to the floor -> (0, "clamp_to_zero").
    """
    if quantity >= 0:
        return (quantity, "noop")
    if not depends_on_stock:
        return (quantity, "flag_manual_review")
    if out_of_stock_policy == 1 and has_pending_backorder_paid:
        return (quantity, "flag_manual_review")
    return (0, "clamp_to_zero")


def clamp_stock_row_to_zero(id_stock_available):
    # Fetch the schema first, then only patch quantity, leaving every other
    # field on the row untouched, matching the documented webservice contract.
    api_get("stock_availables", {"schema": "synopsis"})
    current = api_get(f"stock_availables/{id_stock_available}", {"display": "full"})
    row = current.get("stock_available") or {}
    row["quantity"] = 0
    if DRY_RUN:
        log.info("[DRY RUN] would set stock_availables/%s quantity -> 0", id_stock_available)
        return None
    r = requests.put(
        f"{BASE_URL}/api/stock_availables/{id_stock_available}",
        params={"output_format": "JSON"},
        json={"stock_available": row},
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    rows = negative_stock_rows()
    clamped = 0
    flagged = 0
    for row in rows:
        has_backorder = has_open_backorder_paid_order(row["id_product"])
        _, action = clamp_negative_stock(
            row["quantity"], row["depends_on_stock"], row["out_of_stock"], has_backorder
        )
        if action == "noop":
            continue
        if action == "flag_manual_review":
            log.warning(
                "Flag for review: stock_available %s product %s attribute %s quantity %s",
                row["id"], row["id_product"], row["id_product_attribute"], row["quantity"],
            )
            flagged += 1
            continue
        log.warning(
            "Drift: stock_available %s product %s attribute %s quantity %s -> 0 (%s)",
            row["id"], row["id_product"], row["id_product_attribute"], row["quantity"],
            "would clamp" if DRY_RUN else "clamping",
        )
        if not DRY_RUN:
            clamp_stock_row_to_zero(row["id"])
        clamped += 1
    log.info(
        "Done. %d row(s) %s, %d row(s) flagged for manual review.",
        clamped, "to clamp" if DRY_RUN else "clamped", flagged,
    )


if __name__ == "__main__":
    run()
