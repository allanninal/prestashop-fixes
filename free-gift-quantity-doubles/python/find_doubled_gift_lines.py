"""Find PrestaShop carts where an automatic free-gift line ended up at quantity 2 or
more after an unrelated cart item was removed.

An automatic free-gift cart rule (no voucher code, gift_product and
gift_product_attribute set) is re-evaluated by Cart::updateQty() on every cart
mutation. When the qualifying line item is removed, PrestaShop first drops the cart's
applicable cart rules, recalculates them, and re-adds the gift row through the same
"up" quantity operator used for normal products. Because the gift's existing
ps_cart_product row (quantity 1, is_gift=1) has not been cleaned up yet at that point,
the increment adds 1 to the existing row instead of inserting a fresh one, leaving the
gift line at quantity 2 with no cart rule authorizing more than one free unit. Tracked
upstream as PrestaShop/PrestaShop#22270, fixed in 1.7.7.0; the same class of desync can
still recur in forks or custom modules on older codebases.

This script only reports. The optional, DRY_RUN-guarded corrective step only resets the
quantity to 1 on a cart row confirmed to be a pure gift line (no separate non-gift row
for the same product/attribute exists in the same cart); it never touches a cart row
that also carries a genuinely purchased quantity of the same product. Safe to run
again and again.

Guide: https://www.allanninal.dev/prestashop/free-gift-quantity-doubles/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_doubled_gift_lines")

BASE_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DATE_FROM = os.environ.get("DATE_FROM", "2026-07-01")
DATE_TO = os.environ.get("DATE_TO", "2026-07-11")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


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
        json=body,
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def open_carts(date_from, date_to, limit="0,200"):
    data = api_get("carts", {
        "display": "full",
        "filter[date_upd]": f"[{date_from},{date_to}]",
        "limit": limit,
    })
    return data.get("carts") or []


def cart_rows(cart):
    assoc = cart.get("associations") or {}
    rows = assoc.get("cart_rows") or []
    return [
        {
            "id_product": int(row["id_product"]),
            "id_product_attribute": int(row.get("id_product_attribute") or 0),
            "quantity": int(row["quantity"]),
        }
        for row in rows
    ]


def gift_granting_cart_rules():
    data = api_get("cart_rules", {"display": "full", "filter[active]": "1"})
    rules = data.get("cart_rules") or []
    out = []
    for rule in rules:
        gift_product = int(rule.get("gift_product") or 0)
        if gift_product <= 0:
            continue
        out.append({
            "id_cart_rule": int(rule["id"]),
            "gift_product": gift_product,
            "gift_product_attribute": int(rule.get("gift_product_attribute") or 0),
            "code": rule.get("code") or "",
        })
    return out


def find_doubled_gift_lines(cart_rows_list, gift_rules):
    """
    cart_rows_list: [{"id_product": int, "id_product_attribute": int, "quantity": int}, ...]
    gift_rules: [{"id_cart_rule": int, "gift_product": int, "gift_product_attribute": int,
      "code": str}, ...]

    Returns a list of finding dicts: {"id_product", "id_product_attribute", "quantity",
      "id_cart_rule", "is_automatic"}. Rows with quantity <= 1, or with no matching gift
      rule, are excluded. is_automatic is True when the matching rule's code is empty,
      matching the reported bug's no-code path.

    Pure function: no I/O, takes plain lists/dicts, returns a plain list.
    """
    gift_lookup = {}
    for rule in gift_rules:
        if rule["gift_product"] <= 0:
            continue
        key = (rule["gift_product"], rule["gift_product_attribute"])
        gift_lookup[key] = rule

    findings = []
    for row in cart_rows_list:
        if row["quantity"] <= 1:
            continue
        key = (row["id_product"], row["id_product_attribute"])
        rule = gift_lookup.get(key)
        if rule is None:
            continue
        findings.append({
            "id_product": row["id_product"],
            "id_product_attribute": row["id_product_attribute"],
            "quantity": row["quantity"],
            "id_cart_rule": rule["id_cart_rule"],
            "is_automatic": rule["code"] == "",
        })
    return findings


def is_pure_gift_row(cart_rows_list, id_product, id_product_attribute, gift_quantity):
    """True only when the doubled quantity is explained entirely by the gift row,
    i.e. there is no separate non-gift row for the same product/attribute in this
    cart that would make a quantity rewrite destroy a legitimately purchased unit.
    A cart with exactly one row for the product/attribute at the observed doubled
    quantity is safe to correct; more than one row means a human must look.
    """
    matching = [
        r for r in cart_rows_list
        if r["id_product"] == id_product and r["id_product_attribute"] == id_product_attribute
    ]
    return len(matching) == 1 and matching[0]["quantity"] == gift_quantity


def correct_gift_quantity(cart_id, cart, id_product, id_product_attribute):
    body = {"cart": dict(cart)}
    for row in body["cart"].get("associations", {}).get("cart_rows", []):
        if int(row["id_product"]) == id_product and int(row.get("id_product_attribute") or 0) == id_product_attribute:
            row["quantity"] = 1
    if DRY_RUN:
        log.info("Dry run: would PUT carts/%s to reset product %s quantity to 1", cart_id, id_product)
        return None
    return api_put(f"carts/{cart_id}", body)


def run():
    gift_rules = gift_granting_cart_rules()
    carts = open_carts(DATE_FROM, DATE_TO)

    total_findings = 0
    for cart in carts:
        cart_id = int(cart["id"])
        rows = cart_rows(cart)
        findings = find_doubled_gift_lines(rows, gift_rules)
        for finding in findings:
            total_findings += 1
            log.warning(
                "Cart %s: product %s (attribute %s) at quantity %s, granted by cart rule %s (automatic=%s)",
                cart_id, finding["id_product"], finding["id_product_attribute"],
                finding["quantity"], finding["id_cart_rule"], finding["is_automatic"],
            )
            if is_pure_gift_row(rows, finding["id_product"], finding["id_product_attribute"], finding["quantity"]):
                correct_gift_quantity(cart_id, cart, finding["id_product"], finding["id_product_attribute"])
            else:
                log.warning(
                    "Cart %s: product %s has another non-gift row too, skipping automatic correction",
                    cart_id, finding["id_product"],
                )
    log.info("Done. %d doubled gift line(s) found.", total_findings)


if __name__ == "__main__":
    run()
