"""Find and repair PrestaShop order lines whose refunded quantity is stale
after a credit slip was created through the webservice.

POST /api/order_slip only inserts rows into order_slip and order_slip_detail. It
never runs the back office refund logic in OrderSlip::create() or
AdminOrdersController, which is what actually recalculates and writes
order_detail.product_quantity_refunded, the refund totals, and the related stock
movement. So a credit slip can exist while the order line still reports its old
refunded quantity.

This script sums product_quantity from every order_slip_detail row per
id_order_detail to get the expected refunded quantity, compares it against the
stored product_quantity_refunded, and only writes the corrected value when
DRY_RUN is explicitly false. A negative delta (stored higher than expected) is
always flagged for a human, never auto-corrected.

Guide: https://www.allanninal.dev/prestashop/api-refund-not-updating-order-line/

Run on demand for a suspected order id, or on a schedule across recent orders.
Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_api_refund_quantity")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
ORDER_IDS = os.environ.get("ORDER_IDS", "1,2,3")
AUTH = (PRESTASHOP_WS_KEY, "")


def compute_refund_delta(stored_refunded_qty, order_slip_quantities):
    """Pure decision logic, no I/O.

    Sums order_slip_quantities to get the expected refunded quantity, and
    compares it against stored_refunded_qty. needs_repair means the API-created
    credit slips claim more refunded units than the order line shows, the
    exact symptom this script exists to fix. needs_review means the stored
    value is already higher than the credit slips justify, which is left for
    a human rather than corrected automatically.
    """
    expected = sum(order_slip_quantities)
    delta = expected - stored_refunded_qty
    return {
        "expected": expected,
        "stored": stored_refunded_qty,
        "delta": delta,
        "needs_repair": expected > stored_refunded_qty,
        "needs_review": expected < stored_refunded_qty,
    }


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def order_slips_for(id_order):
    data = api_get("order_slip", params={"filter[id_order]": id_order, "display": "full"})
    return data.get("order_slips") or []


def order_detail(id_order_detail):
    data = api_get(f"order_details/{id_order_detail}", params={"display": "full"})
    return data["order_detail"]


def order_history_states(id_order):
    data = api_get("order_histories", params={"filter[id_order]": id_order, "display": "full"})
    return [h.get("id_order_state") for h in (data.get("order_histories") or [])]


def refund_quantities_by_line(order_slips):
    """Group order_slip_detail rows by id_order_detail and collect their quantities."""
    by_line = {}
    for slip in order_slips:
        details = (slip.get("associations", {}) or {}).get("order_slip_detail") or slip.get("order_slip_detail") or []
        for row in details:
            id_order_detail = row["id_order_detail"]
            by_line.setdefault(id_order_detail, []).append(int(row["product_quantity"]))
    return by_line


def apply_expected_refund(id_order_detail, expected_qty):
    full = api_get(f"order_details/{id_order_detail}")["order_detail"]
    unit_price_tax_excl = float(full.get("unit_price_tax_excl", 0) or 0)
    unit_price_tax_incl = float(full.get("unit_price_tax_incl", 0) or 0)
    full["product_quantity_refunded"] = expected_qty
    if "total_refunded_tax_excl" in full:
        full["total_refunded_tax_excl"] = f"{expected_qty * unit_price_tax_excl:.6f}"
    if "total_refunded_tax_incl" in full:
        full["total_refunded_tax_incl"] = f"{expected_qty * unit_price_tax_incl:.6f}"
    r = requests.put(
        f"{PRESTASHOP_URL}/api/order_details/{id_order_detail}",
        params={"output_format": "JSON"},
        json={"order_detail": full},
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    checked = 0
    repaired = 0
    flagged_for_review = 0
    for id_order in [s.strip() for s in ORDER_IDS.split(",") if s.strip()]:
        slips = order_slips_for(id_order)
        if not slips:
            continue
        by_line = refund_quantities_by_line(slips)
        history_states = order_history_states(id_order)
        for id_order_detail, quantities in by_line.items():
            detail = order_detail(id_order_detail)
            stored = int(detail.get("product_quantity_refunded", 0) or 0)
            result = compute_refund_delta(stored, quantities)
            checked += 1
            if result["delta"] == 0:
                continue
            if result["needs_review"]:
                flagged_for_review += 1
                log.warning(
                    "Needs human review. id_order=%s id_order_detail=%s stored=%d expected=%d delta=%d",
                    id_order, id_order_detail, result["stored"], result["expected"], result["delta"],
                )
                continue
            if not history_states:
                flagged_for_review += 1
                log.warning(
                    "Skipping repair, no order_histories rows found. id_order=%s id_order_detail=%s",
                    id_order, id_order_detail,
                )
                continue
            log.info(
                "Refund quantity stale. id_order=%s id_order_detail=%s stored=%d expected=%d %s",
                id_order, id_order_detail, result["stored"], result["expected"],
                "would repair" if DRY_RUN else "repairing",
            )
            if not DRY_RUN:
                apply_expected_refund(id_order_detail, result["expected"])
                verify = order_detail(id_order_detail)
                log.info(
                    "Verified. id_order_detail=%s product_quantity_refunded=%s",
                    id_order_detail, verify.get("product_quantity_refunded"),
                )
            repaired += 1
    log.info(
        "Done. %d line(s) checked, %d repaired, %d flagged for review. DRY_RUN=%s",
        checked, repaired, flagged_for_review, DRY_RUN,
    )


if __name__ == "__main__":
    run()
