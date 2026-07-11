"""Detect PrestaShop products whose live price resolution disagrees with the
best legitimate price a customer actually qualifies for.

PrestaShop resolves a product's effective price by scanning specific_price rows
(and specific_price_rule catalog rules) that match the request context, id_shop,
id_currency, id_country, id_group, id_customer, and picking the first one that
matches according to a fixed priority order: Shop, then Currency, then Country,
then Group, and within Group the most specific id_group or id_customer is meant
to beat "all groups" or "all customers." It does not compute every matching rule
and choose the numerically lowest resulting price. Because All Groups
(id_group=0) and generic country or currency wildcards sit in a priority
position that is not strictly "more specific wins," a broader rule can be
selected over a narrower, better rule that actually applies to the customer's
real group or currency. Confirmed in PrestaShop/PrestaShop issue #33736 and the
related discussion in #33440 and #14516 on specific_price versus catalog rule
priority.

This is a core pricing-engine priority-resolution defect, not a bad data row,
so the default action is to flag every mismatch for manual review. A
DRY_RUN-guarded repair is available only for a single, operator-confirmed
superseded specific_price row, targeted by its own id, never a bulk delete.

Guide: https://www.allanninal.dev/prestashop/specific-price-priority-wrong/

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("check_specific_price_priority")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
STALE_ROW_ID = os.environ.get("CONFIRMED_STALE_SPECIFIC_PRICE_ID")
AUTH = (PRESTASHOP_WS_KEY, "")

EPSILON = 0.01
ZERO_DATE_PREFIXES = ("0000-00-00",)


def _date_open(value):
    return not value or str(value).startswith(ZERO_DATE_PREFIXES)


def resolve_best_specific_price(base_price, candidate_rules, context):
    """Pure decision function, no I/O.

    base_price: pre-tax product price (number).
    candidate_rules: list of dicts, each with id_group, id_currency, id_country,
    id_customer, reduction, reduction_type ('amount' or 'percentage'),
    from_quantity, from (date string or None/zero-date), to (date string or
    None/zero-date).
    context: dict with customer_group_ids (set/list of int), currency_id,
    country_id, customer_id, quantity, now (PrestaShop "YYYY-MM-DD HH:MM:SS"
    string, compared lexicographically, which works because that format sorts
    the same lexicographically as chronologically).

    Filters candidate_rules to the ones matching context, computes each
    matching rule's resulting unit price, and returns a dict with best_price
    (the numerically lowest resulting price, i.e. the customer-optimal price)
    and winning_rule_index (the index into candidate_rules of the rule that
    produced it, or None if no rule matches, meaning base_price applies as-is).
    """
    now = context["now"]
    group_ids = set(context.get("customer_group_ids") or [])
    best_price = None
    winning_index = None
    for index, rule in enumerate(candidate_rules):
        if rule["id_group"] != 0 and rule["id_group"] not in group_ids:
            continue
        if rule["id_currency"] != 0 and rule["id_currency"] != context["currency_id"]:
            continue
        if rule["id_country"] != 0 and rule["id_country"] != context["country_id"]:
            continue
        if rule["id_customer"] != 0 and rule["id_customer"] != context["customer_id"]:
            continue
        if context["quantity"] < rule["from_quantity"]:
            continue
        if not _date_open(rule.get("from")) and now < rule["from"]:
            continue
        if not _date_open(rule.get("to")) and now > rule["to"]:
            continue

        if rule["reduction_type"] == "percentage":
            price = base_price * (1 - rule["reduction"])
        else:
            price = base_price - rule["reduction"]

        if best_price is None or price < best_price:
            best_price = price
            winning_index = index

    if best_price is None:
        return {"best_price": base_price, "winning_rule_index": None}
    return {"best_price": best_price, "winning_rule_index": winning_index}


def find_price_mismatch(recalculated_best_price, api_reported_price):
    """Pure decision function, no I/O.

    Returns True when the store served a worse (higher) price than what the
    customer legitimately qualifies for, beyond a currency-rounding epsilon.
    """
    return (api_reported_price - recalculated_best_price) > EPSILON


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def api_delete(path):
    r = requests.delete(f"{PRESTASHOP_URL}/api/{path}", auth=AUTH, timeout=30)
    r.raise_for_status()


def customer_group_ids(id_customer):
    data = api_get(f"customers/{id_customer}", params={"display": "full"})
    customer = data.get("customer") or {}
    groups = ((customer.get("associations") or {}).get("groups")) or []
    ids = {int(g["id"]) for g in groups if g.get("id")}
    if customer.get("id_default_group"):
        ids.add(int(customer["id_default_group"]))
    return ids


def product_base_price(id_product):
    data = api_get(f"products/{id_product}", params={"display": "full"})
    product = data.get("product") or {}
    return float(product.get("price") or 0), product


def specific_prices_for(id_product):
    data = api_get("specific_prices", params={"filter[id_product]": id_product, "display": "full"})
    return data.get("specific_prices") or []


def specific_price_rules():
    data = api_get("specific_price_rules", params={"display": "full"})
    return data.get("specific_price_rules") or []


def api_reported_price(id_product, id_customer, id_currency):
    """Re-read the product price the way the storefront would, using PrestaShop's
    own filter parameters so its live resolution logic runs, not ours."""
    data = api_get(f"products/{id_product}", params={
        "display": "full",
        "id_customer": id_customer,
        "id_currency": id_currency,
    })
    product = data.get("product") or {}
    return float(product.get("price") or 0)


def normalize_rule(row):
    return {
        "id_group": int(row.get("id_group") or 0),
        "id_currency": int(row.get("id_currency") or 0),
        "id_country": int(row.get("id_country") or 0),
        "id_customer": int(row.get("id_customer") or 0),
        "reduction": float(row.get("reduction") or 0),
        "reduction_type": row.get("reduction_type") or "amount",
        "from_quantity": int(row.get("from_quantity") or 1),
        "from": row.get("from"),
        "to": row.get("to"),
        "id": row.get("id"),
    }


def check_product_for_customer(id_product, id_customer, currency_id, country_id, quantity, now):
    base_price, _product = product_base_price(id_product)
    rows = [normalize_rule(r) for r in specific_prices_for(id_product)]
    context = {
        "customer_group_ids": customer_group_ids(id_customer),
        "currency_id": currency_id,
        "country_id": country_id,
        "customer_id": id_customer,
        "quantity": quantity,
        "now": now,
    }
    result = resolve_best_specific_price(base_price, rows, context)
    served = api_reported_price(id_product, id_customer, currency_id)
    mismatched = find_price_mismatch(result["best_price"], served)
    return {
        "id_product": id_product,
        "id_customer": id_customer,
        "recalculated_best_price": result["best_price"],
        "winning_rule_index": result["winning_rule_index"],
        "winning_rule": rows[result["winning_rule_index"]] if result["winning_rule_index"] is not None else None,
        "api_reported_price": served,
        "mismatched": mismatched,
    }


def repair_confirmed_stale_row(specific_price_id):
    """Only ever targets a single, operator-confirmed superseded specific_price
    id. Never a bulk delete, never called automatically without CONFIRMED_STALE_
    SPECIFIC_PRICE_ID being explicitly set."""
    log.warning(
        "%s specific_prices/%s: would DELETE this single confirmed-stale row",
        "DRY RUN" if DRY_RUN else "REPAIRING", specific_price_id,
    )
    if not DRY_RUN:
        api_delete(f"specific_prices/{specific_price_id}")


def run(pairs=None):
    """pairs is a list of (id_product, id_customer, currency_id, country_id, quantity, now).
    Each entry describes one product/customer combination to check. Populate this
    from your own source of "customers who recently viewed or ordered this
    product," since the webservice has no single endpoint that enumerates every
    live combination on its own."""
    pairs = pairs or []
    flagged = 0
    for id_product, id_customer, currency_id, country_id, quantity, now in pairs:
        row = check_product_for_customer(id_product, id_customer, currency_id, country_id, quantity, now)
        if row["mismatched"]:
            flagged += 1
            log.warning(
                "Price mismatch. id_product=%s id_customer=%s recalculated_best_price=%.2f "
                "api_reported_price=%.2f winning_rule=%s",
                row["id_product"], row["id_customer"], row["recalculated_best_price"],
                row["api_reported_price"], row["winning_rule"],
            )
    if STALE_ROW_ID:
        repair_confirmed_stale_row(STALE_ROW_ID)
    log.info("Done. %d id_product/id_customer pair(s) flagged for review.", flagged)


if __name__ == "__main__":
    run()
