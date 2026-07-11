"""Detect and safely backfill PrestaShop orders missing an invoice after an API state change.

An invoice number is not read off the order, it lives on a separate order_invoice row
that PrestaShop only creates inside Order::setInvoice(), which only runs when a new
order_histories entry is added for a state whose own order_state.invoice flag is 1,
and only while PS_INVOICE is enabled for the shop. A webservice POST to order_histories
updates current_state correctly but does not always trigger that same invoicing side
effect, and if the target state was never flagged as invoice-eligible, or the shop has
PS_INVOICE off, no order_invoice row is ever created no matter how the state changed.

This script lists orders sitting on an invoice-eligible current state, reads each
order's existing order_invoices, and only ever writes for the safe, deterministic case:
the state is genuinely eligible, PS_INVOICE is on, the order is valid, and no invoice
row exists yet. Anything else is left alone or flagged for manual review.

Guide: https://www.allanninal.dev/prestashop/invoice-number-missing-after-api-status-change/

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backfill_missing_invoice")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
SHIPPED_STATE_ID = int(os.environ.get("SHIPPED_STATE_ID", "4"))
INVOICING_ENABLED = os.environ.get("PS_INVOICE_ENABLED", "true").lower() == "true"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def decide_invoice_repair(order, state_is_invoiceable, invoicing_enabled, existing_invoices):
    """Pure decision function, no I/O.

    order: {id, reference, valid, current_state}
    state_is_invoiceable: bool, order_state.invoice == 1 for order.current_state
    invoicing_enabled: bool, PS_INVOICE for the shop
    existing_invoices: list, order.associations.order_invoices
    Returns a dict with an action of none, generate_invoice, flag_manual_review, or skip.
    """
    if not invoicing_enabled:
        return {"action": "skip", "reason": "ps_invoice_disabled"}

    if not state_is_invoiceable:
        return {"action": "skip", "reason": "current_state_not_invoice_eligible"}

    if existing_invoices:
        return {"action": "none", "reason": "invoice_already_exists"}

    if not order.get("valid"):
        return {"action": "flag_manual_review", "reason": "order_not_valid_yet"}

    return {"action": "generate_invoice", "reason": "eligible_state_missing_invoice"}


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def orders_on_state(state_id):
    data = api_get("orders", params={
        "filter[current_state]": f"[{state_id}]",
        "display": "full",
    })
    return data.get("orders") or []


def order_state_is_invoiceable(state_id):
    data = api_get(f"order_states/{state_id}", params={"display": "full"})
    state = data.get("order_state") or {}
    return str(state.get("invoice")) == "1"


def order_invoices_for(order_id):
    data = api_get(f"orders/{order_id}", params={"display": "full"})
    order = data.get("order") or {}
    associations = order.get("associations") or {}
    return associations.get("order_invoices") or []


def generate_invoice(order_id):
    body = {"order_invoice": {"id_order": order_id}}
    r = requests.post(
        f"{PRESTASHOP_URL}/api/order_invoices",
        params={"output_format": "JSON"},
        json=body,
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    generated = 0
    flagged = 0
    skipped = 0
    state_is_invoiceable = order_state_is_invoiceable(SHIPPED_STATE_ID)

    for order in orders_on_state(SHIPPED_STATE_ID):
        id_order = order["id"]
        reference = order.get("reference")
        existing_invoices = order_invoices_for(id_order)
        decision = decide_invoice_repair(order, state_is_invoiceable, INVOICING_ENABLED, existing_invoices)

        if decision["action"] == "none":
            continue

        if decision["action"] == "skip":
            skipped += 1
            log.info("Order %s (id=%s) skipped: %s", reference, id_order, decision["reason"])
            continue

        if decision["action"] == "flag_manual_review":
            flagged += 1
            log.warning("Order %s (id=%s) flagged for manual review: %s",
                        reference, id_order, decision["reason"])
            continue

        log.info("Order %s (id=%s) missing invoice. %s",
                  reference, id_order, "would generate" if DRY_RUN else "generating")
        if DRY_RUN:
            continue

        generate_invoice(id_order)
        generated += 1

    log.info("Done. %d invoice(s) generated, %d flagged, %d skipped. DRY_RUN=%s",
              generated, flagged, skipped, DRY_RUN)


if __name__ == "__main__":
    run()
