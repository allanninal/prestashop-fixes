"""Audit PrestaShop multistore orders for tax calculated at the wrong country's rate.

Each shop in a multistore install has its own default country, but the tax
engine is supposed to resolve the rate from the invoice address's
id_country through PS_TAX_ADDRESS_TYPE and the TaxRulesGroup/TaxManager
classes. When the address is incomplete, when an order arrives through
pickup in store or the webservice without a full id_address_invoice, or
when a price context falls back to the shop's own country, the TaxManager
can silently use the shop's default country tax rule instead of the
customer's real one.

This script reads a range of orders, recomputes the expected tax from each
order line's id_tax_rules_group and the invoice address's real id_country,
and compares it to the stored total_paid_tax_incl. It only writes an audit
report by default. A stored total tied to an invoice must never be
auto-corrected in place, so DRY_RUN=false only offers a repair path for
orders still in an editable, unpaid current_state, and even then requires
an explicit human confirmation before it writes anything.

Guide: https://www.allanninal.dev/prestashop/multistore-wrong-country-tax-rate/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("audit_multistore_tax_rate")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
ID_ORDER_START = int(os.environ.get("ID_ORDER_START", "1"))
ID_ORDER_END = int(os.environ.get("ID_ORDER_END", "1"))
EDITABLE_STATE_NAMES = {"awaiting payment", "awaiting check payment", "awaiting bank wire payment"}

EPSILON = 0.02


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


def api_post(path, body):
    r = requests.post(
        f"{PRESTASHOP_URL}/api/{path}",
        params={"output_format": "JSON"},
        json=body,
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def compute_expected_tax(unit_price_tax_excl, quantity, tax_rate_pct):
    """Pure math: expected tax inclusive total for one order line."""
    expected_tax_excl_total = round(unit_price_tax_excl * quantity, 2)
    expected_tax_incl_total = round(expected_tax_excl_total * (1 + tax_rate_pct / 100), 2)
    return expected_tax_incl_total


def select_applicable_tax_rate(order_country_id, shop_default_country_id, tax_rules):
    """
    tax_rules: list of {"id_country": int, "rate": float} for one id_tax_rules_group.
    Must select the rule for order_country_id (the invoice address country), and must
    NOT fall back to shop_default_country_id when a matching rule for order_country_id
    exists and the two ids differ. Pure decision logic, no I/O.
    """
    for rule in tax_rules:
        if int(rule["id_country"]) == int(order_country_id):
            return float(rule["rate"])
    for rule in tax_rules:
        if int(rule["id_country"]) == int(shop_default_country_id):
            return float(rule["rate"])
    return 0.0


def get_order(id_order):
    data = api_get(f"orders/{id_order}", {"display": "full"})
    return data.get("order") or {}


def get_address_country(id_address):
    data = api_get(f"addresses/{id_address}", {"display": "full"})
    address = data.get("address") or {}
    return int(address.get("id_country") or 0) or None


def get_order_lines(id_order):
    data = api_get("order_details", {
        "filter[id_order]": id_order,
        "display": "full",
    })
    return data.get("order_details") or []


def get_tax_rules(id_tax_rules_group):
    data = api_get("tax_rules", {
        "filter[id_tax_rules_group]": id_tax_rules_group,
        "display": "full",
    })
    return data.get("tax_rules") or []


def is_editable_state(id_order_state):
    data = api_get(f"order_states/{id_order_state}", {"display": "full"})
    state = data.get("order_state") or {}
    name = state.get("name")
    if isinstance(name, dict):
        name = next(iter(name.values()), "")
    return str(name or "").strip().lower() in EDITABLE_STATE_NAMES


def scan_order(id_order):
    order = get_order(id_order)
    id_shop = int(order.get("id_shop") or 0)
    id_address_invoice = int(order.get("id_address_invoice") or 0)
    stored_total = float(order.get("total_paid_tax_incl") or 0)
    current_state = int(order.get("current_state") or 0)

    order_country_id = get_address_country(id_address_invoice)
    shop = api_get(f"shops/{id_shop}", {"display": "full"}).get("shop") or {}
    shop_default_country_id = int(shop.get("id_country") or order_country_id or 0)

    lines = get_order_lines(id_order)
    expected_total = 0.0
    line_findings = []
    for line in lines:
        id_tax_rules_group = int(line.get("id_tax_rules_group") or 0)
        unit_price = float(line.get("unit_price_tax_excl") or 0)
        quantity = int(line.get("product_quantity") or 0)
        tax_rules = get_tax_rules(id_tax_rules_group)
        rate = select_applicable_tax_rate(order_country_id, shop_default_country_id, tax_rules)
        expected_line_total = compute_expected_tax(unit_price, quantity, rate)
        expected_total += expected_line_total
        line_findings.append({
            "id_order_detail": line.get("id"),
            "id_tax_rules_group": id_tax_rules_group,
            "unit_price_tax_excl": unit_price,
            "product_quantity": quantity,
            "expected_rate": rate,
            "expected_total_price_tax_incl": expected_line_total,
        })

    if abs(stored_total - expected_total) <= EPSILON:
        return None

    return {
        "id_order": id_order,
        "id_shop": id_shop,
        "id_address_invoice": id_address_invoice,
        "order_country_id": order_country_id,
        "shop_default_country_id": shop_default_country_id,
        "current_state": current_state,
        "stored_total_paid_tax_incl": stored_total,
        "expected_total_paid_tax_incl": round(expected_total, 2),
        "lines": line_findings,
    }


def apply_correction(finding, confirmed):
    if not confirmed:
        log.info("Order %s: correction available but not confirmed, skipping write.", finding["id_order"])
        return
    if not is_editable_state(finding["current_state"]):
        log.warning("Order %s: current_state %s is not editable, refusing to write.",
                    finding["id_order"], finding["current_state"])
        return

    for line in finding["lines"]:
        api_put(f"order_details/{line['id_order_detail']}", {
            "total_price_tax_incl": line["expected_total_price_tax_incl"],
            "total_price_tax_excl": round(line["unit_price_tax_excl"] * line["product_quantity"], 2),
            "unit_price_tax_incl": round(line["expected_total_price_tax_incl"] / max(line["product_quantity"], 1), 2),
        })

    api_put(f"orders/{finding['id_order']}", {
        "total_paid_tax_incl": finding["expected_total_paid_tax_incl"],
        "total_paid": finding["expected_total_paid_tax_incl"],
        "total_paid_tax_excl": round(sum(l["unit_price_tax_excl"] * l["product_quantity"] for l in finding["lines"]), 2),
    })

    api_post("order_histories", {
        "id_order": finding["id_order"],
        "id_order_state": finding["current_state"],
    })
    log.info("Order %s: corrected to expected total %.2f.", finding["id_order"], finding["expected_total_paid_tax_incl"])


def run():
    findings = []
    for id_order in range(ID_ORDER_START, ID_ORDER_END + 1):
        finding = scan_order(id_order)
        if finding:
            findings.append(finding)
            log.warning(
                "Order %s (shop %s): stored total_paid_tax_incl %.2f, expected %.2f for country %s.",
                finding["id_order"], finding["id_shop"],
                finding["stored_total_paid_tax_incl"], finding["expected_total_paid_tax_incl"],
                finding["order_country_id"],
            )
            if not DRY_RUN:
                apply_correction(finding, confirmed=False)
    log.info("Done. %d order(s) flagged for review.", len(findings))
    return findings


if __name__ == "__main__":
    run()
