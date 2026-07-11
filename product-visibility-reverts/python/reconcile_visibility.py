"""Detect and repair PrestaShop products whose visibility silently reverts.

visibility ("both"/"catalog"/"search"/"none") lives per shop in ps_product_shop,
keyed by id_shop, not as a single attribute on the product. Scheduled sync jobs
(ERP feeds, price/stock updaters, marketplace connectors) typically PUT the full
product resource on every run from a source of truth that never tracked a
merchant's manual visibility override, so each sync silently writes visibility
back to "both" (PrestaShop/PrestaShop GitHub issue #14386). Multistore installs
also carry a long standing webservice bug where PUT does not reliably honor
id_shop scoping, so a change meant for one shop can land on, or be read back
from, the default shop instead (issues #15317 and #35901).

This script keeps an intended-state list of (product_id, id_shop) -> visibility,
reads the real value scoped by id_shop, and reapplies a drifted value exactly
once with a scoped PUT. If the same pair reverts again after that one reapply,
it stops writing and flags the pair for a human instead of looping against a
job it cannot see.

Guide: https://www.allanninal.dev/prestashop/product-visibility-reverts/

Run on a schedule. Safe to run again and again.
"""
import os
import json
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_visibility")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")

# Local record of pairs already reapplied once, so a second revert gets flagged
# instead of repaired again. In production, persist this to a file or a database.
REPAIRED_ONCE_STATE_FILE = os.environ.get("REPAIRED_ONCE_STATE_FILE", "repaired_once.json")


def decide_visibility_action(intended, actual, already_repaired_once):
    """Pure decision function, no I/O.

    intended: dict[(product_id, id_shop) -> visibility] of what the merchant wants.
    actual: dict[(product_id, id_shop) -> visibility] read back from PrestaShop.
    already_repaired_once: set of (product_id, id_shop) keys already reapplied once
        in a previous run, used as the repair-loop cutoff.

    For each key in intended, compares actual.get(key) to intended[key]:
      - equal                                        -> action "none"
      - different and key not in already_repaired_once -> action "reapply"
      - different and key IS in already_repaired_once   -> action "flag"
        (a prior reapply already reverted again, do not auto-repair a second time)

    Returns a list of {product_id, id_shop, intended, actual, action} decision
    records, one per key in intended. No network or DB calls.
    """
    decisions = []
    for key, intended_value in intended.items():
        product_id, id_shop = key
        actual_value = actual.get(key)

        if actual_value == intended_value:
            action = "none"
        elif key not in already_repaired_once:
            action = "reapply"
        else:
            action = "flag"

        decisions.append({
            "product_id": product_id,
            "id_shop": id_shop,
            "intended": intended_value,
            "actual": actual_value,
            "action": action,
        })
    return decisions


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def api_put(path, resource_key, body, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.put(
        f"{PRESTASHOP_URL}/api/{path}",
        params=params, auth=AUTH,
        json={resource_key: body}, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def list_shops():
    data = api_get("shops", params={"display": "full"})
    return data.get("shops") or []


def actual_visibility(id_product, id_shop):
    data = api_get(f"products/{id_product}", params={
        "display": "[id,visibility,active,id_shop_default]",
        "id_shop": id_shop,
    })
    product = data.get("product") or {}
    return product.get("visibility")


def find_drifted_to_both(product_ids):
    id_list = "[" + ",".join(str(i) for i in product_ids) + "]"
    data = api_get("products", params={
        "filter[visibility]": "both",
        "filter[id]": id_list,
        "display": "[id,visibility]",
    })
    return data.get("products") or []


def reapply_visibility(id_product, id_shop, visibility):
    body = {"id": id_product, "visibility": visibility}
    return api_put(f"products/{id_product}", "product", body, params={"id_shop": id_shop})


def load_repaired_once():
    if not os.path.exists(REPAIRED_ONCE_STATE_FILE):
        return set()
    with open(REPAIRED_ONCE_STATE_FILE) as f:
        pairs = json.load(f)
    return {(p[0], p[1]) for p in pairs}


def save_repaired_once(pairs):
    with open(REPAIRED_ONCE_STATE_FILE, "w") as f:
        json.dump([[p[0], p[1]] for p in sorted(pairs)], f)


def run(intended):
    """intended: dict[(product_id, id_shop) -> visibility]."""
    already_repaired_once = load_repaired_once()

    actual = {}
    for product_id, id_shop in intended:
        actual[(product_id, id_shop)] = actual_visibility(product_id, id_shop)

    decisions = decide_visibility_action(intended, actual, already_repaired_once)

    reapplied = 0
    flagged = 0
    newly_repaired = set(already_repaired_once)

    for d in decisions:
        key = (d["product_id"], d["id_shop"])
        if d["action"] == "none":
            continue
        if d["action"] == "reapply":
            log.warning(
                "Product %s shop %s drifted: intended=%s actual=%s. %s",
                d["product_id"], d["id_shop"], d["intended"], d["actual"],
                "would reapply" if DRY_RUN else "reapplying",
            )
            if not DRY_RUN:
                reapply_visibility(d["product_id"], d["id_shop"], d["intended"])
                newly_repaired.add(key)
            reapplied += 1
        elif d["action"] == "flag":
            log.error(
                "Product %s shop %s reverted again after a repair: intended=%s actual=%s. "
                "Not auto-repairing again, a competing job is likely overwriting this.",
                d["product_id"], d["id_shop"], d["intended"], d["actual"],
            )
            flagged += 1

    if not DRY_RUN:
        save_repaired_once(newly_repaired)

    log.info("Done. %d pair(s) reapplied, %d pair(s) flagged for a human.", reapplied, flagged)
    return decisions


if __name__ == "__main__":
    # Example intended-state list. Replace with your real source, e.g. a JSON
    # file or a database table of products you deliberately hid per shop.
    example_intended = {
        (12, 1): "none",
        (12, 2): "both",
    }
    run(example_intended)
