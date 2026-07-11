"""Diagnose catalog listing price mismatches across PrestaShop shops.

In multistore, per shop overrides for price and discounts live in
ps_product_shop and ps_specific_price, keyed by id_shop or id_shop_group,
while the base ps_product row holds only a default fallback value. Several
core controllers and list queries, notably the backoffice Catalog product
list (GitHub #12853), join or read from ps_product instead of the shop
scoped ps_product_shop, and Product::getFinalPrice() / specific price
resolution can also fail to filter strictly by the loaded shop context
(GitHub #20780), so a listing can surface one shop's price or discount
while the single product page, which does resolve context correctly via
id_shop, shows a different shop's real price for the same id_product.

This script reads every shop, then for each product in a given id range
pulls the listing context price and the single product context price for
that id_shop and compares them with a pure decision function. It only
reports by default. This is a core price resolution bug, not a simple data
write problem, so auto-fixing via the webservice is unsafe in general; the
correct remediation is applying or upgrading to the PrestaShop core fix for
the relevant tracker issue. Set DRY_RUN=false only after confirming the
discrepancy is a stray specific_price row scoped to the wrong shop, in
which case the script sends one scoped PUT per id_product and id_shop
carrying the correct price, then re-verifies both prices.
"""
import os
import logging
from decimal import Decimal
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("diagnose_multistore_listing_price")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
PRICE_TOLERANCE = Decimal(os.environ.get("PRICE_TOLERANCE", "0.01"))
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


def api_put(path, body, params=None):
    p = dict(params or {})
    p["output_format"] = "JSON"
    r = requests.put(
        f"{PRESTASHOP_URL}/api/{path}",
        params=p,
        json=body,
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def decide_price_mismatch(listing_price, single_product_price, id_product, id_shop, tolerance=Decimal("0.01")):
    """
    listing_price: Decimal, the price as it would appear in a catalog listing for id_shop.
    single_product_price: Decimal, the price from the canonical single product view for id_shop.
    Pure decision logic, no I/O, so it is easy to unit test with hardcoded price pairs.
    Returns a dict describing the comparison and whether it counts as a mismatch.
    """
    diff = abs(listing_price - single_product_price)
    return {
        "id_product": id_product,
        "id_shop": id_shop,
        "mismatch": diff > tolerance,
        "diff": diff,
        "listing_price": listing_price,
        "single_product_price": single_product_price,
    }


def all_shops():
    data = api_get("shops", {"display": "full"})
    return data.get("shops") or []


def listing_price(id_product, id_shop):
    data = api_get("products", {
        "id_shop": id_shop,
        "filter[id]": id_product,
        "filter[active]": 1,
        "display": "full",
    })
    rows = data.get("products") or []
    return Decimal(str(rows[0]["price"])) if rows else None


def single_product_price(id_product, id_shop):
    data = api_get(f"products/{id_product}", {"id_shop": id_shop, "display": "full"})
    product = data.get("product") or {}
    return Decimal(str(product["price"])) if "price" in product else None


def scan_product(id_product, shops, tolerance):
    findings = []
    for shop in shops:
        id_shop = int(shop["id"])
        listing = listing_price(id_product, id_shop)
        single = single_product_price(id_product, id_shop)
        if listing is None or single is None:
            continue
        result = decide_price_mismatch(listing, single, id_product, id_shop, tolerance)
        if result["mismatch"]:
            findings.append(result)
    return findings


def repair_finding(finding):
    """Guarded corrective action for a confirmed stray specific_price row.
    Only ever called when DRY_RUN is False. Writes the single product's
    correct price back for that one id_shop, then re-verifies both views.
    """
    id_product = finding["id_product"]
    id_shop = finding["id_shop"]
    correct_price = finding["single_product_price"]

    log.info("Product %s shop %s: writing scoped price %s. %s",
              id_product, id_shop, correct_price, "would write" if DRY_RUN else "writing")
    if DRY_RUN:
        return

    api_put(f"products/{id_product}", {"price": str(correct_price)}, params={"id_shop": id_shop})

    new_listing = listing_price(id_product, id_shop)
    new_single = single_product_price(id_product, id_shop)
    recheck = decide_price_mismatch(new_listing, new_single, id_product, id_shop, PRICE_TOLERANCE)
    if recheck["mismatch"]:
        log.warning("Product %s shop %s: still mismatched after write (diff %s).",
                    id_product, id_shop, recheck["diff"])
    else:
        log.info("Product %s shop %s: verified in agreement after write.", id_product, id_shop)


def run():
    shops = all_shops()
    total_findings = 0
    for id_product in range(ID_PRODUCT_START, ID_PRODUCT_END + 1):
        findings = scan_product(id_product, shops, PRICE_TOLERANCE)
        for finding in findings:
            log.warning("Product %s shop %s: listing=%s single=%s diff=%s",
                        finding["id_product"], finding["id_shop"],
                        finding["listing_price"], finding["single_product_price"], finding["diff"])
            repair_finding(finding)
            total_findings += 1
    log.info("Done. %d product/shop mismatch(es) %s.", total_findings, "to repair" if DRY_RUN else "handled")


if __name__ == "__main__":
    run()
