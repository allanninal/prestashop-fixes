"""Flag and, once confirmed, repair PrestaShop stock corrupted by a duplicate
or reverted order status change.

OrderHistory::changeIdOrderState() applies a signed stock delta for every state
transition it sees, with no memory of transitions it already applied. A duplicate
order_histories row for the same target state, or a reverted status, makes it
apply the same delta again. This script independently replays an order's status
timeline with a pure decision function, diffs the expected quantity against the
live stock_availables value, and reports a record per mismatch. It only writes a
compensating correction when DRY_RUN is false, and it re-reads stock right before
writing so the correction is based on the latest quantity.

Guide: https://www.allanninal.dev/prestashop/stock-quantity-corrupted-on-status-change/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_stock")

BASE_URL = os.environ.get("PRESTASHOP_URL", "https://example-store.test").rstrip("/")
WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "DUMMYKEY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

NEUTRAL_STATE = {"id": 0, "logable": False, "shipped": False}


def expected_stock_delta(from_state, to_state, line_quantity, applied_state_ids_seen, candidate_state_id):
    if candidate_state_id in applied_state_ids_seen:
        return 0
    if not from_state["logable"] and to_state["logable"]:
        return -line_quantity
    if from_state["logable"] and not to_state["logable"]:
        return line_quantity
    return 0


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{BASE_URL}/api/{path}", params=params, auth=(WS_KEY, ""), timeout=30)
    r.raise_for_status()
    return r.json()


def api_put(path, body):
    r = requests.put(
        f"{BASE_URL}/api/{path}",
        params={"output_format": "JSON"},
        auth=(WS_KEY, ""),
        json=body,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def order_history(id_order):
    data = api_get("order_histories", {"filter[id_order]": id_order, "display": "full"})
    rows = data.get("order_histories") or []
    return sorted(rows, key=lambda r: (r.get("date_add") or "", int(r.get("id", 0))))


def order_lines(id_order):
    data = api_get("order_details", {"filter[id_order]": id_order, "display": "full"})
    return data.get("order_details") or []


def state_flags(id_order_state):
    data = api_get(f"order_states/{id_order_state}")
    s = data["order_state"]
    return {"id": int(id_order_state), "logable": s.get("logable") == "1", "shipped": s.get("shipped") == "1"}


def stock_available(id_product, id_product_attribute):
    data = api_get("stock_availables", {
        "filter[id_product]": id_product,
        "filter[id_product_attribute]": id_product_attribute or 0,
        "display": "full",
    })
    rows = data.get("stock_availables") or []
    return rows[0] if rows else None


def replay_expected_delta(history_rows, line_quantity, state_flags_fn=state_flags):
    seen = []
    total = 0
    from_state = dict(NEUTRAL_STATE)
    for row in history_rows:
        to_id = int(row["id_order_state"])
        to_state = state_flags_fn(to_id)
        total += expected_stock_delta(from_state, to_state, line_quantity, seen, to_id)
        seen.append(to_id)
        from_state = to_state
    return total


def duplicate_history_ids(history_rows):
    seen_state_at = {}
    duplicates = []
    for row in history_rows:
        state_id = int(row["id_order_state"])
        row_id = int(row["id"])
        if state_id in seen_state_at:
            duplicates.append(row_id)
        else:
            seen_state_at[state_id] = row_id
    return duplicates


def reconcile_order(id_order):
    history_rows = order_history(id_order)
    findings = []
    for line in order_lines(id_order):
        id_product = int(line["id_product"])
        id_product_attribute = int(line.get("id_product_attribute") or 0)
        line_quantity = int(line["product_quantity"])

        expected_delta = replay_expected_delta(history_rows, line_quantity)
        stock = stock_available(id_product, id_product_attribute)
        if stock is None:
            continue
        observed_quantity = int(stock["quantity"])

        duplicate_ids = duplicate_history_ids(history_rows)
        if expected_delta == 0 and not duplicate_ids:
            continue

        findings.append({
            "id_order": id_order,
            "id_product": id_product,
            "id_product_attribute": id_product_attribute,
            "id_stock_available": int(stock["id"]),
            "observed_quantity": observed_quantity,
            "expected_delta": expected_delta,
            "duplicate_order_histories_ids": duplicate_ids,
        })
    return findings


def apply_correction(finding):
    """Compensating write. Only called when DRY_RUN is false and a human confirmed."""
    fresh = stock_available(finding["id_product"], finding["id_product_attribute"])
    if fresh is None:
        raise RuntimeError("stock_availables row disappeared before write")
    before = int(fresh["quantity"])
    after = before - finding["expected_delta"]
    fresh["quantity"] = str(after)
    api_put(f"stock_availables/{finding['id_stock_available']}", {"stock_available": fresh})
    log.info("Corrected stock_availables %s: %d -> %d", finding["id_stock_available"], before, after)


def run(order_ids):
    all_findings = []
    for id_order in order_ids:
        findings = reconcile_order(id_order)
        for finding in findings:
            log.warning(
                "Order %s product %s (attr %s): observed=%d expected_delta=%d duplicates=%s",
                finding["id_order"], finding["id_product"], finding["id_product_attribute"],
                finding["observed_quantity"], finding["expected_delta"],
                finding["duplicate_order_histories_ids"],
            )
        all_findings.extend(findings)

    if not DRY_RUN:
        for finding in all_findings:
            apply_correction(finding)

    log.info("Done. %d finding(s) %s.", len(all_findings), "to review" if DRY_RUN else "corrected")
    return all_findings


if __name__ == "__main__":
    ids = [int(x) for x in os.environ.get("ORDER_IDS", "").split(",") if x.strip()]
    run(ids)
