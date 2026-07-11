"""Swap a PrestaShop product's default combination without hitting product_default.

ps_product_attribute has a unique key (product_default) that allows only one
row per id_product to hold default_on=1. The back office clears default_on on
the old default and sets it on the new one in a single save. The Webservice
API does not do that clearing step for you, so PUTting default_on=1 on a new
combination while another one still holds it collides with the unique key and
PrestaShop returns a duplicate entry error for product_default.

This script reads the combinations for a product, finds whichever one
currently holds default_on=1, and if it is not already the target, clears it
first with one PUT, then sets default_on=1 on the target with a second PUT.
If the target is already the default it does nothing. Set DRY_RUN=false to
let it write for real.

Guide: https://www.allanninal.dev/prestashop/webservice-default-combination-duplicate-key/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("swap_default_combination")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(
        f"{PRESTASHOP_URL}/api/{path}",
        params=params,
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def api_put(path, body):
    r = requests.put(
        f"{PRESTASHOP_URL}/api/{path}",
        params={"output_format": "JSON"},
        json=body,
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def combinations_for_product(id_product):
    data = api_get("combinations", {
        "filter[id_product]": id_product,
        "display": "full",
    })
    return data.get("combinations") or []


def current_default_id(rows):
    for row in rows:
        if int(row.get("default_on") or 0) == 1:
            return int(row["id"])
    return None


def plan_default_swap(current_default_id, target_id):
    """Pure decision: given the id currently flagged default and the id we
    want to become default, return the ordered list of writes to make.

    Returns an empty list when the target is already the default. Otherwise
    returns at most two steps, always in this order: clear the old default
    first, then set the new one. That order is what avoids ever having two
    rows claim default_on=1 at the same time.
    """
    if current_default_id == target_id:
        return []
    steps = []
    if current_default_id is not None:
        steps.append({"id": current_default_id, "default_on": 0})
    steps.append({"id": target_id, "default_on": 1})
    return steps


def set_default_on(row, default_on):
    body = dict(row)
    body["default_on"] = default_on
    return api_put(f"combinations/{row['id']}", body)


def run(id_product, target_id):
    rows = combinations_for_product(id_product)
    by_id = {int(row["id"]): row for row in rows}

    if target_id not in by_id:
        raise SystemExit(f"Combination {target_id} was not found on product {id_product}.")

    old_default_id = current_default_id(rows)
    steps = plan_default_swap(old_default_id, target_id)

    if not steps:
        log.info("Combination %s is already the default for product %s. Nothing to do.", target_id, id_product)
        return

    for step in steps:
        row = by_id[step["id"]]
        log.info(
            "Setting combination %s default_on=%s. %s",
            step["id"], step["default_on"], "would write" if DRY_RUN else "writing",
        )
        if not DRY_RUN:
            set_default_on(row, step["default_on"])

    log.info(
        "Done. %s default combination for product %s from %s to %s.",
        "Would swap" if DRY_RUN else "Swapped", id_product, old_default_id, target_id,
    )


if __name__ == "__main__":
    target_product = os.environ.get("TARGET_ID_PRODUCT")
    target_combination = os.environ.get("TARGET_ID_COMBINATION")
    if not target_product or not target_combination:
        raise SystemExit("Set TARGET_ID_PRODUCT and TARGET_ID_COMBINATION to run this.")
    run(int(target_product), int(target_combination))
