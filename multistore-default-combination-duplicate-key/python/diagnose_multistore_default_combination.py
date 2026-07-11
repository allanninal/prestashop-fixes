"""Diagnose duplicate or missing default combinations across PrestaShop shops.

In multistore, the default combination flag is meant to be scoped per shop
through product_attribute_shop, but the unique index behind product_default
was not always shop aware in older 1.6 style code paths. Creating or
converting a default combination on a second shop can then collide with the
default already set on the first shop, and the failed write can leave a shop
with two combinations flagged default_on=1, or with none at all.

This script reads every shop, then for each product in a given id range
pulls that product's combinations filtered to each id_shop and classifies
the state with a pure function. It only reports by default. Set
DRY_RUN=false to also apply a two step repair per flagged product and shop:
clear every extra default row in that shop first, one PUT per
id_product_attribute, then PUT the product's id_default_combination to the
surviving row.

Guide: https://www.allanninal.dev/prestashop/multistore-default-combination-duplicate-key/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("diagnose_multistore_default_combination")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
ID_PRODUCT_START = int(os.environ.get("ID_PRODUCT_START", "1"))
ID_PRODUCT_END = int(os.environ.get("ID_PRODUCT_END", "1"))


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


def classify_default_combination_state(combinations, id_default_combination, shop_active):
    """
    combinations: list of {"id": int, "id_product_attribute": int, "default_on": "0"|"1"|None}
                  for ONE id_shop context.
    id_default_combination: the product resource's pointer (Products.id_default_combination)
                             for that shop context, or None.
    shop_active: whether the product is active/associated to this shop.
    Returns one of: "OK", "DUPLICATE_DEFAULT", "MISSING_DEFAULT", "POINTER_MISMATCH",
    "NOT_APPLICABLE".
    Pure decision logic, no I/O -- unit test with synthetic combination lists.
    """
    if not combinations:
        return "NOT_APPLICABLE"
    default_flags = [c for c in combinations if str(c.get("default_on")) == "1"]
    if len(default_flags) > 1:
        return "DUPLICATE_DEFAULT"
    if len(default_flags) == 0:
        return "MISSING_DEFAULT" if shop_active else "NOT_APPLICABLE"
    only_default = default_flags[0]
    if id_default_combination is not None and only_default["id_product_attribute"] != id_default_combination:
        return "POINTER_MISMATCH"
    return "OK"


def all_shops():
    data = api_get("shops", {"display": "full"})
    return data.get("shops") or []


def combinations_for_product_shop(id_product, id_shop):
    data = api_get("combinations", {
        "filter[id_product]": id_product,
        "id_shop": id_shop,
        "display": "full",
    })
    return data.get("combinations") or []


def product_default_combination(id_product):
    data = api_get(f"products/{id_product}", {"display": "full"})
    raw = (data.get("product") or {}).get("id_default_combination")
    return int(raw) if raw not in (None, "", "0") else None


def scan_product(id_product, shops):
    findings = []
    id_default_combination = product_default_combination(id_product)
    for shop in shops:
        id_shop = int(shop["id"])
        shop_active = str(shop.get("active", "1")) == "1"
        combos = combinations_for_product_shop(id_product, id_shop)
        state = classify_default_combination_state(combos, id_default_combination, shop_active)
        if state not in ("OK", "NOT_APPLICABLE"):
            findings.append({
                "id_product": id_product,
                "id_shop": id_shop,
                "state": state,
                "combinations": combos,
            })
    return findings


def repair_finding(finding):
    id_product = finding["id_product"]
    id_shop = finding["id_shop"]
    state = finding["state"]
    combos = finding["combinations"]

    if state == "DUPLICATE_DEFAULT":
        defaults = [c for c in combos if str(c.get("default_on")) == "1"]
        survivor = min(defaults, key=lambda c: int(c["id_product_attribute"]))
        extras = [c for c in defaults if c is not survivor]
    elif state == "MISSING_DEFAULT":
        survivor = min(combos, key=lambda c: int(c["id_product_attribute"]))
        extras = []
    elif state == "POINTER_MISMATCH":
        defaults = [c for c in combos if str(c.get("default_on")) == "1"]
        survivor = defaults[0]
        extras = []
    else:
        return

    for extra in extras:
        pa_id = extra["id_product_attribute"]
        log.info("Product %s shop %s: clearing default_on on id_product_attribute %s. %s",
                  id_product, id_shop, pa_id, "would write" if DRY_RUN else "writing")
        if not DRY_RUN:
            api_put(f"combinations/{pa_id}", {**extra, "default_on": 0})

    pa_id = survivor["id_product_attribute"]
    log.info("Product %s shop %s: setting id_default_combination to %s. %s",
              id_product, id_shop, pa_id, "would write" if DRY_RUN else "writing")
    if not DRY_RUN:
        api_put(f"products/{id_product}", {"id_default_combination": pa_id})


def run():
    shops = all_shops()
    total_findings = 0
    for id_product in range(ID_PRODUCT_START, ID_PRODUCT_END + 1):
        findings = scan_product(id_product, shops)
        for finding in findings:
            log.warning("Product %s shop %s: %s", finding["id_product"], finding["id_shop"], finding["state"])
            repair_finding(finding)
            total_findings += 1
    log.info("Done. %d product/shop finding(s) %s.", total_findings, "to repair" if DRY_RUN else "repaired")


if __name__ == "__main__":
    run()
