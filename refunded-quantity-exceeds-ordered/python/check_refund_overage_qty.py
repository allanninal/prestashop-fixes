"""Detect PrestaShop order_detail rows where the refunded quantity exceeds the
ordered quantity.

PrestaShop stores product_quantity and product_quantity_refunded as independent
unsigned columns on order_detail. Standard and partial refunds, issued through
IssueStandardRefundCommand or IssuePartialRefundCommand, increment
product_quantity_refunded without ever adjusting product_quantity, and nothing in
the back office validates that the refunded count stays under the ordered count.
If a line's quantity is later edited down by hand, or repeated partial refunds
keep stacking against the same line outside the normal flow, product_quantity_refunded
can end up bigger than product_quantity. Per PrestaShop/PrestaShop#39391 this can
later throw SQLSTATE[22003]: 1690 BIGINT UNSIGNED value is out of range in
'product_quantity - product_quantity_refunded' when core code computes that
subtraction for stock or shippable-quantity checks.

This script flags affected lines by default. It never overwrites
product_quantity_refunded unless DRY_RUN is explicitly false and the order id is
in an operator-confirmed CONFIRM_ORDER_IDS list, and even then it only clamps
product_quantity_refunded down to product_quantity, re-sending the full
order_detail resource body as PrestaShop's webservice requires on a PUT.

Guide: https://www.allanninal.dev/prestashop/refunded-quantity-exceeds-ordered/

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_refund_overage")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
DATE_FROM = os.environ.get("DATE_FROM", "2026-06-01")
DATE_TO = os.environ.get("DATE_TO", "2026-07-11")
CONFIRM_ORDER_IDS = {
    int(x) for x in os.environ.get("CONFIRM_ORDER_IDS", "").split(",") if x.strip()
}
AUTH = (PRESTASHOP_WS_KEY, "")


def find_refund_overage(order_lines):
    """Pure decision logic, no I/O.

    Input: a list of order_detail dicts already fetched from the API, each with
    keys id, id_order, product_id, product_quantity (int), product_quantity_refunded
    (int), product_quantity_return (int), product_quantity_reinjected (int).

    For each line, computes delta = product_quantity_refunded - product_quantity;
    a positive delta is a finding tagged refunded_exceeds_ordered. Also flags,
    separately tagged, lines where product_quantity_return exceeds
    product_quantity (returned_exceeds_ordered) or product_quantity_reinjected
    exceeds product_quantity_refunded (reinjected_exceeds_refunded), the same
    manual-edit-after-refund pattern showing up on a sibling column.

    Returns the list of findings sorted by overage descending.
    """
    findings = []
    for line in order_lines:
        ordered = int(line["product_quantity"])
        refunded = int(line["product_quantity_refunded"])
        returned = int(line.get("product_quantity_return", 0))
        reinjected = int(line.get("product_quantity_reinjected", 0))
        delta = refunded - ordered
        if delta > 0:
            findings.append({
                "id_order": line["id_order"],
                "id": line["id"],
                "product_id": line["product_id"],
                "ordered": ordered,
                "refunded": refunded,
                "overage": delta,
                "reason": "refunded_exceeds_ordered",
            })
        if returned > ordered:
            findings.append({
                "id_order": line["id_order"],
                "id": line["id"],
                "product_id": line["product_id"],
                "ordered": ordered,
                "refunded": returned,
                "overage": returned - ordered,
                "reason": "returned_exceeds_ordered",
            })
        if reinjected > refunded:
            findings.append({
                "id_order": line["id_order"],
                "id": line["id"],
                "product_id": line["product_id"],
                "ordered": refunded,
                "refunded": reinjected,
                "overage": reinjected - refunded,
                "reason": "reinjected_exceeds_refunded",
            })
    return sorted(findings, key=lambda f: f["overage"], reverse=True)


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def recent_order_ids(date_from, date_to):
    data = api_get("orders", params={"filter[date_add]": f"[{date_from},{date_to}]", "display": "full"})
    return [int(o["id"]) for o in (data.get("orders") or [])]


def order_lines(id_order):
    data = api_get("order_details", params={"filter[id_order]": id_order, "display": "full"})
    return data.get("order_details") or []


def order_slips_for(id_order):
    data = api_get("order_slips", params={"filter[id_order]": id_order, "display": "full"})
    return data.get("order_slips") or []


def clamp_refunded_to_ordered(order_detail_id):
    full = api_get(f"order_details/{order_detail_id}")["order_detail"]
    full["product_quantity_refunded"] = full["product_quantity"]
    r = requests.put(
        f"{PRESTASHOP_URL}/api/order_details/{order_detail_id}",
        params={"output_format": "JSON"},
        json={"order_detail": full},
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    flagged = 0
    repaired = 0
    for id_order in recent_order_ids(DATE_FROM, DATE_TO):
        lines = order_lines(id_order)
        findings = find_refund_overage(lines)
        if not findings:
            continue
        slips = order_slips_for(id_order)
        for finding in findings:
            flagged += 1
            log.warning(
                "Refund overage. id_order=%s id=%s product_id=%s ordered=%s "
                "refunded=%s overage=%s reason=%s credit_slips=%d",
                finding["id_order"], finding["id"], finding["product_id"],
                finding["ordered"], finding["refunded"], finding["overage"],
                finding["reason"], len(slips),
            )
            if not DRY_RUN and finding["reason"] == "refunded_exceeds_ordered" and id_order in CONFIRM_ORDER_IDS:
                clamp_refunded_to_ordered(finding["id"])
                repaired += 1
                log.info("Clamped order_detail id=%s refunded down to ordered=%s.", finding["id"], finding["ordered"])
    log.info("Done. %d line(s) flagged for review, %d repaired. DRY_RUN=%s", flagged, repaired, DRY_RUN)


if __name__ == "__main__":
    run()
