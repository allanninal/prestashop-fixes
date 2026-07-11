"""Find PrestaShop stock_available rows that are negative despite a deny backorder policy.

PrestaShop stores a sellable quantity per (id_product, id_product_attribute, id_shop or
id_shop_group) row in stock_available. The front office and order validation code path
only checks the per-product out_of_stock flag (0 deny, 1 allow, 2 use the global
PS_ORDER_OUT_OF_STOCK setting) when a cart turns into an order. It never re-locks or
re-verifies the row at final payment and validation, so two near-simultaneous orders, or
an order racing a manual back-office edit or an import, can each decrement the same row
past zero even with a deny policy. In multistore with Share available quantities on, the
row is scoped to id_shop_group, so any shop in the group can decrement it, and combination
or pack rows that were never correctly scoped can drift negative outside checkout entirely.

This is unsafe to auto-correct blindly, so the default behavior is to flag and report every
genuine violation: a row only counts when the resolved policy is deny yet quantity is
negative. Only when explicitly run with DRY_RUN=false and --clamp does it write quantity
back as max(existing_quantity, 0), preserving id_product, id_product_attribute, the shop
scoping, depends_on_stock, and out_of_stock unchanged so the write never resets the policy.

Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/prestashop/negative-stock-despite-backorder-denied/
"""
import os
import sys
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_negative_stock")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
PRESTASHOP_WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def classify_stock_violation(quantity, out_of_stock, global_default_deny):
    """Pure decision function, no I/O.

    quantity: the stored stock_available.quantity, an int that may be negative.
    out_of_stock: the resolved per-row policy code, 0 deny, 1 allow, 2 inherit default.
    global_default_deny: bool, the resolved PS_ORDER_OUT_OF_STOCK store wide setting.

    Returns {policy, is_violation, clamp_to}. is_violation is True only when the
    effective policy is deny and quantity is negative. clamp_to is the value a clamp
    repair would write, max(quantity, 0), and is None when there is no violation.
    """
    if out_of_stock == 0:
        policy = "deny"
    elif out_of_stock == 1:
        policy = "allow"
    else:
        policy = "deny" if global_default_deny else "allow"

    is_violation = policy == "deny" and quantity < 0
    clamp_to = max(quantity, 0) if is_violation else None
    return {"policy": policy, "is_violation": is_violation, "clamp_to": clamp_to}


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


def all_shops():
    data = api_get("shops", params={"display": "full"})
    return data.get("shops") or []


def negative_stock_rows():
    data = api_get("stock_availables", params={
        "display": "full",
        "filter[quantity]": "[-9999999,-1]",
    })
    return data.get("stock_availables") or []


def global_default_deny():
    data = api_get("configurations", params={"filter[name]": "PS_ORDER_OUT_OF_STOCK", "display": "full"})
    configs = data.get("configurations") or []
    if not configs:
        return True  # PrestaShop ships with deny as the safe default
    return str(configs[0].get("value", "0")) == "0"


def product_out_of_stock(id_product, cache):
    if id_product in cache:
        return cache[id_product]
    data = api_get(f"products/{id_product}", params={"display": "full"})
    product = data.get("product", {})
    value = int(product.get("out_of_stock", 2))
    cache[id_product] = value
    return value


def combination_exists(id_product_attribute):
    if not id_product_attribute or int(id_product_attribute) == 0:
        return True  # 0 means the row belongs to the product itself, not a combination
    data = api_get(f"combinations/{id_product_attribute}")
    return bool(data.get("combination"))


def clamp_row(row):
    body = {
        "id": row["id"],
        "id_product": row["id_product"],
        "id_product_attribute": row.get("id_product_attribute", "0"),
        "id_shop": row.get("id_shop", "0"),
        "id_shop_group": row.get("id_shop_group", "0"),
        "quantity": max(int(row["quantity"]), 0),
        "depends_on_stock": row.get("depends_on_stock", "0"),
        "out_of_stock": row.get("out_of_stock", "2"),
    }
    return api_put(f"stock_availables/{row['id']}", "stock_available", body)


def run(clamp=False):
    shops = all_shops()
    log.info("Scanning %d shop(s) for negative stock_available rows.", len(shops))

    default_deny = global_default_deny()
    product_cache = {}
    flagged = []

    for row in negative_stock_rows():
        id_product = row["id_product"]
        id_product_attribute = row.get("id_product_attribute")
        quantity = int(row["quantity"])
        out_of_stock = product_out_of_stock(id_product, product_cache)

        result = classify_stock_violation(quantity, out_of_stock, default_deny)
        if not result["is_violation"]:
            continue

        has_combination = combination_exists(id_product_attribute)
        flagged.append({
            "id_shop": row.get("id_shop"),
            "id_shop_group": row.get("id_shop_group"),
            "id_product": id_product,
            "id_product_attribute": id_product_attribute,
            "quantity": quantity,
            "resolved_out_of_stock_policy": result["policy"],
            "orphaned_combination": id_product_attribute not in (None, "0", 0) and not has_combination,
        })
        log.warning(
            "Violation: shop=%s product=%s attribute=%s quantity=%s policy=%s",
            row.get("id_shop"), id_product, id_product_attribute, quantity, result["policy"],
        )

        if clamp and not DRY_RUN:
            clamp_row(row)
            log.info("Clamped stock_availables/%s quantity to %s.", row["id"], result["clamp_to"])

    log.info(
        "Done. %d violation(s) found. %s",
        len(flagged),
        "Clamped to zero." if clamp and not DRY_RUN else "Reported only, no writes made.",
    )
    return flagged


if __name__ == "__main__":
    clamp_flag = "--clamp" in sys.argv
    run(clamp=clamp_flag)
