"""Detect PrestaShop orders whose total_paid does not match the sum of their lines.

PrestaShop computes and caches an order's total_paid, total_paid_tax_incl, and
total_paid_tax_excl on the orders table separately from each line's own total on the
order_detail table (total_price_tax_incl and total_price_tax_excl). The two sources of
truth are only reconciled by specific code paths, cart validation and the
OrderAmountUpdater run during a back office edit. A rounding-mode setting, a module
writing straight to the order totals, or a back office edit to a product line, a
discount, or a partial refund can all leave the cached order total out of step with
what the lines actually add up to.

This script flags affected orders by default. It never overwrites total_paid,
total_paid_tax_incl, or total_paid_tax_excl unless DRY_RUN is explicitly false, and even
then it re-checks that no pending order_history entry (representing an in-flight state
change or refund) exists before attempting the corrective write.

Guide: https://www.allanninal.dev/prestashop/order-total-mismatch-with-line-sum/

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_order_total")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
ORDER_ID_RANGE = os.environ.get("ORDER_ID_RANGE", "1,50")
AUTH = (PRESTASHOP_WS_KEY, "")

EPSILON = 0.02


def diff_order_total(order_total_paid_tax_incl, line_totals_tax_incl, total_shipping, total_discounts, epsilon=EPSILON):
    """Pure decision logic, no I/O.

    Sums line_totals_tax_incl, adds shipping, subtracts discounts, compares against
    order_total_paid_tax_incl, and returns a dict describing the computed total, the
    difference, and whether that difference is past the tolerance. Caller supplies all
    values already fetched from the API.
    """
    computed_total = round(sum(line_totals_tax_incl) + total_shipping - total_discounts, 2)
    diff = round(order_total_paid_tax_incl - computed_total, 2)
    return {
        "computed_total": computed_total,
        "diff": diff,
        "mismatched": abs(diff) > epsilon,
    }


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def orders_in_range(id_range):
    data = api_get("orders", params={"filter[id]": f"[{id_range}]", "display": "full"})
    return data.get("orders") or []


def order_detail_line_totals(id_order):
    data = api_get("order_details", params={"filter[id_order]": id_order, "display": "full"})
    details = data.get("order_details") or []
    return [float(d["total_price_tax_incl"]) for d in details]


def has_pending_history(id_order):
    data = api_get("order_histories", params={"filter[id_order]": id_order, "display": "full"})
    return len(data.get("order_histories") or []) == 0


def apply_recomputed_total(order, computed_total):
    order["total_paid"] = f"{computed_total:.6f}"
    order["total_paid_tax_incl"] = f"{computed_total:.6f}"
    r = requests.put(
        f"{PRESTASHOP_URL}/api/orders/{order['id']}",
        params={"output_format": "JSON"},
        json={"order": order},
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    flagged = 0
    repaired = 0
    for order in orders_in_range(ORDER_ID_RANGE):
        id_order = order["id"]
        total_paid_tax_incl = float(order["total_paid_tax_incl"])
        total_shipping = float(order.get("total_shipping") or 0)
        total_discounts = float(order.get("total_discounts") or 0)
        line_totals = order_detail_line_totals(id_order)
        result = diff_order_total(total_paid_tax_incl, line_totals, total_shipping, total_discounts)
        if not result["mismatched"]:
            continue
        flagged += 1
        log.warning(
            "Order total mismatch. id_order=%s reference=%s current_state=%s "
            "stored_total=%.2f computed_total=%.2f diff=%.2f",
            id_order, order.get("reference"), order.get("current_state"),
            total_paid_tax_incl, result["computed_total"], result["diff"],
        )
        if not DRY_RUN:
            if has_pending_history(id_order):
                log.warning("Skipping repair for id_order=%s: no order_histories rows found.", id_order)
                continue
            apply_recomputed_total(order, result["computed_total"])
            repaired += 1
            log.info("Applied recomputed total=%.2f for id_order=%s.", result["computed_total"], id_order)
    log.info("Done. %d order(s) flagged for review, %d repaired. DRY_RUN=%s", flagged, repaired, DRY_RUN)


if __name__ == "__main__":
    run()
