"""Detect PrestaShop split orders with a mismatched carrier or shipping cost.

When a cart contains products assigned to different carriers, or products a carrier
excludes by weight or zone rules, PrestaShop's checkout splits the cart into multiple
orders that share the same reference but each get their own row in order_carriers, one
per id_order/id_order_invoice pair. The split logic frequently mis-assigns which order
gets which carrier row: one split order ends up with no id_carrier and 0.00 shipping cost
while another gets an extra, duplicated shipping charge, so total_paid summed across the
split orders no longer equals the original cart total, and the carrier shown on an order
does not match what it was actually charged.

This script flags affected orders by default. It never overwrites id_carrier or the
shipping totals unless DRY_RUN is explicitly false, and even then it only attempts a
corrective write for the narrow shipping_cost_mismatch case, where order_carriers already
holds a single unambiguous row for that order. A missing carrier row entirely, or a
duplicated charge with no matching order_carriers row, is always left for a human.

Run against the references you are investigating. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_split_shipping")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
REFERENCES = [r.strip() for r in os.environ.get("REFERENCES", "").split(",") if r.strip()]
AUTH = (PRESTASHOP_WS_KEY, "")

TOLERANCE = 0.01


def find_shipping_mismatches(orders, order_carriers):
    """Pure decision logic, no I/O.

    Groups order_carriers by id_order, then for each order checks whether its
    id_carrier and total_shipping_tax_incl agree with its matching order_carriers row.
    Returns a list of {id, reference, reason} dicts, reason one of
    missing_carrier_with_nonzero_shipping, carrier_id_mismatch, shipping_cost_mismatch,
    zero_shipping_with_carrier_assigned.
    """
    by_order = {}
    for row in order_carriers:
        by_order.setdefault(row["id_order"], []).append(row)

    mismatches = []
    for order in orders:
        id_order = order["id"]
        id_carrier = order.get("id_carrier") or 0
        shipping = float(order.get("total_shipping_tax_incl") or 0)
        rows = by_order.get(id_order) or []

        if not rows:
            if shipping > TOLERANCE:
                mismatches.append({"id": id_order, "reference": order.get("reference"),
                                    "reason": "missing_carrier_with_nonzero_shipping"})
            continue

        row = rows[0]
        row_carrier = row.get("id_carrier") or 0
        row_shipping = float(row.get("shipping_cost_tax_incl") or 0)

        if id_carrier == 0 and row_shipping > TOLERANCE:
            mismatches.append({"id": id_order, "reference": order.get("reference"),
                                "reason": "zero_shipping_with_carrier_assigned"})
        elif id_carrier != 0 and row_carrier != 0 and id_carrier != row_carrier:
            mismatches.append({"id": id_order, "reference": order.get("reference"),
                                "reason": "carrier_id_mismatch"})
        elif abs(shipping - row_shipping) > TOLERANCE:
            mismatches.append({"id": id_order, "reference": order.get("reference"),
                                "reason": "shipping_cost_mismatch"})
    return mismatches


def reconcile_reference_total(orders_for_reference):
    """Pure function, no I/O.

    Returns (sum_total_paid, expected_total) for a group of orders sharing one
    reference, purely from the passed-in dicts. expected_total is computed from each
    order's own total_products_wt, total_shipping_tax_incl, and total_discounts_tax_incl.
    """
    sum_total_paid = round(sum(float(o.get("total_paid_tax_incl") or 0) for o in orders_for_reference), 2)
    expected_total = round(sum(
        float(o.get("total_products_wt") or 0)
        + float(o.get("total_shipping_tax_incl") or 0)
        - float(o.get("total_discounts_tax_incl") or 0)
        for o in orders_for_reference
    ), 2)
    return sum_total_paid, expected_total


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def orders_for_reference(reference):
    data = api_get("orders", params={"filter[reference]": reference, "display": "full"})
    return data.get("orders") or []


def order_carriers_for(order_ids):
    if not order_ids:
        return []
    id_filter = "[" + "|".join(str(i) for i in order_ids) + "]"
    data = api_get("order_carriers", params={"filter[id_order]": id_filter, "display": "full"})
    return data.get("order_carriers") or []


def apply_carrier_row_to_order(order, row):
    order["id_carrier"] = row["id_carrier"]
    order["total_shipping_tax_incl"] = f"{float(row['shipping_cost_tax_incl']):.6f}"
    order["total_shipping_tax_excl"] = row.get("shipping_cost_tax_excl", order.get("total_shipping_tax_excl"))
    r = requests.put(
        f"{PRESTASHOP_URL}/api/orders/{order['id']}",
        params={"output_format": "JSON"},
        json={"order": order},
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def reapply_current_state(id_order, id_order_state):
    r = requests.post(
        f"{PRESTASHOP_URL}/api/order_histories",
        params={"output_format": "JSON"},
        json={"order_history": {"id_order": id_order, "id_order_state": id_order_state}},
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    flagged = 0
    repaired = 0
    for reference in REFERENCES:
        orders = orders_for_reference(reference)
        if not orders:
            continue
        order_ids = [o["id"] for o in orders]
        rows = order_carriers_for(order_ids)
        by_order = {}
        for row in rows:
            by_order.setdefault(row["id_order"], []).append(row)

        mismatches = find_shipping_mismatches(orders, rows)
        for m in mismatches:
            flagged += 1
            log.warning("Split shipping mismatch. id=%s reference=%s reason=%s",
                        m["id"], m["reference"], m["reason"])
            if not DRY_RUN and m["reason"] == "shipping_cost_mismatch":
                order = next(o for o in orders if o["id"] == m["id"])
                matching_rows = by_order.get(m["id"]) or []
                if len(matching_rows) == 1:
                    apply_carrier_row_to_order(order, matching_rows[0])
                    reapply_current_state(order["id"], order["current_state"])
                    repaired += 1
                    log.info("Repaired shipping on id_order=%s from order_carriers.", order["id"])
                else:
                    log.warning("Skipping repair for id_order=%s: order_carriers not unambiguous.", m["id"])

        sum_paid, expected = reconcile_reference_total(orders)
        if abs(sum_paid - expected) > TOLERANCE:
            log.warning("Reference total mismatch. reference=%s sum_total_paid=%.2f expected_total=%.2f",
                        reference, sum_paid, expected)

    log.info("Done. %d mismatch(es) flagged, %d repaired. DRY_RUN=%s", flagged, repaired, DRY_RUN)


if __name__ == "__main__":
    run()
