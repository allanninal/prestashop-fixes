"""Find PrestaShop cart rules that were created with no code, auto-apply to qualifying
carts, and are now permanently unusable because their quantity ran out, their date_to
passed, or they were deactivated.

These codeless rules are matched by conditions rather than a customer-typed string, so
the back office has never had a reliable way to know it is safe to offer a delete
affordance for one (PrestaShop core issues #12608 and #20246). Once dead, they are never
purged, so they pile up in the cart_rule table and clutter admin listings and reports.

This script only reports by default. The optional, DRY_RUN-guarded delete step only
fires for ids a human lists in CONFIRMED_DELETE_IDS after reviewing the report, and even
then only after re-confirming order_cart_rules has zero rows for that id, since a rule
that is dead going forward can still be the rule a real, already finalized order used.
Safe to run again and again.

Guide: https://www.allanninal.dev/prestashop/orphaned-codeless-vouchers-accumulate/
"""
import os
import csv
import logging
import requests
from datetime import date, datetime

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("report_orphaned_vouchers")

BASE_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
REPORT_PATH = os.environ.get("REPORT_PATH", "orphaned_vouchers_report.csv")
CONFIRMED_DELETE_IDS = {
    int(x) for x in os.environ.get("CONFIRMED_DELETE_IDS", "").split(",") if x.strip()
}


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{BASE_URL}/api/{path}", params=params, auth=(WS_KEY, ""), timeout=30)
    r.raise_for_status()
    return r.json()


def api_delete(path):
    r = requests.delete(
        f"{BASE_URL}/api/{path}",
        params={"output_format": "JSON"},
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.status_code


def list_cart_rules(limit=1000):
    data = api_get("cart_rules", {"display": "full", "limit": limit})
    rules = data.get("cart_rules") or []
    out = []
    for rule in rules:
        out.append({
            "id": int(rule["id"]),
            "name": rule.get("name") or "",
            "code": rule.get("code") or "",
            "quantity": int(rule["quantity"]),
            "quantity_per_user": int(rule["quantity_per_user"]),
            "date_from": rule.get("date_from"),
            "date_to": rule.get("date_to"),
            "active": rule.get("active") in ("1", 1, True),
        })
    return out


def has_historical_order(cart_rule_id):
    data = api_get("order_cart_rules", {"filter[id_cart_rule]": cart_rule_id, "display": "full"})
    links = data.get("order_cart_rules") or []
    return len(links) > 0


def is_orphaned_codeless_voucher(code, quantity, date_to, active, today):
    """Pure decision: True when a cart rule is codeless AND (exhausted, expired,
    or disabled). A rule with a real code is never orphaned by this rule, regardless
    of quantity, date_to, or active. No I/O, no network, no side effects.
    """
    if code.strip() != "":
        return False
    if quantity <= 0:
        return True
    if date_to:
        parsed = date_to
        if isinstance(parsed, str):
            parsed = datetime.fromisoformat(parsed.split(" ")[0]).date()
        if parsed < today:
            return True
    if active is False:
        return True
    return False


def write_report(rows, path):
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(
            f, fieldnames=["id_cart_rule", "name", "date_from", "date_to", "quantity", "quantity_per_user"]
        )
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def run():
    today = date.today()
    candidates = []
    for rule in list_cart_rules():
        if not is_orphaned_codeless_voucher(rule["code"], rule["quantity"], rule["date_to"], rule["active"], today):
            continue
        if has_historical_order(rule["id"]):
            log.info("Cart rule %s (%s) is codeless and dead but still referenced by a historical order, skipping.",
                      rule["id"], rule["name"])
            continue
        candidates.append({
            "id_cart_rule": rule["id"],
            "name": rule["name"],
            "date_from": rule["date_from"],
            "date_to": rule["date_to"],
            "quantity": rule["quantity"],
            "quantity_per_user": rule["quantity_per_user"],
        })

    write_report(candidates, REPORT_PATH)
    log.info("Report written to %s with %d orphaned codeless voucher(s).", REPORT_PATH, len(candidates))

    if DRY_RUN or not CONFIRMED_DELETE_IDS:
        log.info("Dry run or no confirmed ids. No cart rule was deleted.")
        return

    candidate_ids = {row["id_cart_rule"] for row in candidates}
    for cart_rule_id in sorted(CONFIRMED_DELETE_IDS):
        if cart_rule_id not in candidate_ids:
            log.warning("Confirmed id %s is not in this run's report, skipping.", cart_rule_id)
            continue
        if has_historical_order(cart_rule_id):
            log.warning("Confirmed id %s now shows a historical order reference, skipping delete.", cart_rule_id)
            continue
        api_delete(f"cart_rules/{cart_rule_id}")
        log.info("Deleted cart rule %s.", cart_rule_id)


if __name__ == "__main__":
    run()
