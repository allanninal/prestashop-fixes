"""Find and repair PrestaShop products whose default combination pointer is stale.

A product with combinations shows its headline price by resolving id_default_combination
to one specific combination row. When that pointer is 0, blank, or names a combination
that was deleted, deactivated, or belongs to a different product, the price lookup has
nothing valid to read and the product displays a price of zero even though its other
combinations have real prices.

This script lists products, pulls each one's live combinations, and checks whether the
stored id_default_combination resolves to an active combination that still belongs to
that product. When it does not and an eligible combination exists, it repairs the
pointer to the cheapest eligible one. When no eligible combination exists at all, it
flags the product for a human instead of guessing. The only write is a PUT on the
product's own id_default_combination field; combination rows are never modified.

Run after bulk combination edits, imports, or product duplication. Safe to run again
and again.

Guide: https://www.allanninal.dev/prestashop/missing-default-combination-zero-price/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_default_combination")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
PRESTASHOP_WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def decide_default_combination(id_product, current_default_id, combinations):
    """Pure decision function, no I/O.

    id_product: the product being checked.
    current_default_id: the product's stored id_default_combination value.
    combinations: the product's live combinations, each a dict with id, id_product,
        active, and price.

    Returns a decision dict describing what to do. All HTTP calls happen in the caller.
    """
    def eligible(c):
        return (
            str(c.get("id_product")) == str(id_product)
            and str(c.get("active", "0")) == "1"
        )

    live_ids = {str(c["id"]) for c in combinations if eligible(c)}
    is_valid = str(current_default_id) not in ("", "0", "None") and str(current_default_id) in live_ids

    if is_valid:
        return {
            "action": "none",
            "reason": "default combination is active and belongs to the product",
            "target_id": None,
        }

    eligible_combos = [c for c in combinations if eligible(c)]
    if not eligible_combos:
        return {
            "action": "flag",
            "reason": "no active combination belongs to this product",
            "target_id": None,
        }

    cheapest = min(eligible_combos, key=lambda c: float(c.get("price", 0) or 0))
    return {
        "action": "repair",
        "reason": "default combination missing or invalid, replacing with cheapest active one",
        "target_id": cheapest["id"],
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


def list_products_with_combinations(limit=100):
    data = api_get("products", params={"display": "full", "limit": limit})
    products = data.get("products") or []
    return [p for p in products if str(p.get("id_default_combination", "0")) != ""]


def list_combinations(id_product):
    data = api_get("combinations", params={
        "filter[id_product]": id_product,
        "display": "full",
    })
    return data.get("combinations") or []


def repair_default_combination(product, target_combination_id):
    body = dict(product)
    body["id_default_combination"] = target_combination_id
    return api_put(f"products/{product['id']}", "product", body)


def run():
    flagged = 0
    repaired = 0
    for product in list_products_with_combinations():
        id_product = product.get("id")
        current_default_id = product.get("id_default_combination")

        combinations = list_combinations(id_product)
        decision = decide_default_combination(id_product, current_default_id, combinations)

        if decision["action"] == "none":
            continue

        flagged += 1
        log.warning(
            "Product %s current id_default_combination=%s action=%s reason=%s target_id=%s",
            id_product, current_default_id, decision["action"], decision["reason"], decision["target_id"],
        )

        if decision["action"] == "repair" and not DRY_RUN:
            repair_default_combination(product, decision["target_id"])
            repaired += 1
            log.info("Repaired product %s id_default_combination=%s.", id_product, decision["target_id"])

    log.info("Done. %d product(s) flagged, %d repaired.", flagged, repaired)


if __name__ == "__main__":
    run()
