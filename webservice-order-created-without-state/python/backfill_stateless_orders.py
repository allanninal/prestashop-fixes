"""Find and backfill PrestaShop orders created via webservice with no state at all.

OrderHistory::changeIdOrderState() is the only code path that both writes an
order_history row and updates the denormalized orders.current_state column, while
also firing the emails, stock, and invoice logic tied to that state. The webservice
orders resource exposes current_state as a plain writable field on the order object,
so a POST to /api/orders that omits it, or sets it directly, never runs the state
machine at all. The order is created with current_state at 0 (or an unapplied value)
and zero rows in order_history. This is documented on the PrestaShop forums under
"Create order via webservice won't set current state," and the reverse case, an
update adding an unexpected history row, is tracked as GitHub issue #11154.

This script only ever repairs through order_histories, the same call the back
office makes internally. It never writes current_state directly onto an order,
since that is the exact bug being fixed. Run on a schedule. Safe to run again
and again, because a repaired order will show up with a real history row on the
next pass and no longer match the stateless filter.

Guide: https://www.allanninal.dev/prestashop/webservice-order-created-without-state/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backfill_stateless_orders")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")

PAID_HINTS = ("payment accepted", "paiement accepté", "paid")
AWAITING_HINTS = ("awaiting", "en attente")


def resolve_backfill_state(order, order_states):
    """Pure decision function, no I/O.

    order: dict with id_order, current_state, total_paid, total_paid_real, payment, valid.
    order_states: list of dicts, each with id, name, logable, hidden.
    Returns the id_order_state to backfill, or None when no safe decision can be made.

    Rules:
      - If order['current_state'] is already set (not 0 and not None), return None; the
        caller is expected to have already confirmed no order_histories rows exist before
        calling this function, since current_state alone does not prove an order is
        stateless.
      - Only "usable" states are considered: logable and not hidden.
      - If the order is fully or over paid (total_paid_real >= total_paid > 0), resolve to
        the single usable state whose name matches a "paid" hint. If zero or more than one
        state matches, return None to force a manual flag rather than guess.
      - Otherwise resolve to the lowest-id usable state whose name matches an "awaiting
        payment" hint. If none match, return None.
    """
    if order.get("current_state") not in (0, None):
        return None

    def usable(s):
        return str(s.get("logable", "0")) in ("1", "true", "True") and \
               str(s.get("hidden", "0")) not in ("1", "true", "True")

    candidates = [s for s in order_states if usable(s)]
    if not candidates:
        return None

    total_paid = float(order.get("total_paid") or 0)
    total_paid_real = float(order.get("total_paid_real") or 0)

    if total_paid > 0 and total_paid_real >= total_paid:
        paid_states = [s for s in candidates if any(h in str(s.get("name", "")).lower() for h in PAID_HINTS)]
        if len(paid_states) == 1:
            return int(paid_states[0]["id"])
        return None

    awaiting_states = [s for s in candidates if any(h in str(s.get("name", "")).lower() for h in AWAITING_HINTS)]
    if not awaiting_states:
        return None
    return int(min(awaiting_states, key=lambda s: int(s["id"]))["id"])


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def candidate_orders():
    data = api_get("orders", params={"display": "full", "filter[current_state]": "0", "limit": "200"})
    return data.get("orders") or []


def is_stateless(id_order):
    data = api_get("order_histories", params={
        "display": "full",
        "filter[id_order]": id_order,
        "limit": "1",
    })
    rows = data.get("order_histories") or []
    return len(rows) == 0


def order_states():
    data = api_get("order_states", params={"display": "full"})
    return data.get("order_states") or []


def backfill_via_history(id_order, resolved_state_id):
    body = {"order_history": {"id_order": id_order, "id_order_state": resolved_state_id}}
    r = requests.post(
        f"{PRESTASHOP_URL}/api/order_histories",
        params={"output_format": "JSON"},
        json=body,
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    states = order_states()
    flagged = 0
    repaired = 0
    for order in candidate_orders():
        id_order = order["id"]
        if not is_stateless(id_order):
            continue
        flagged += 1
        resolved = resolve_backfill_state(order, states)
        if resolved is None:
            log.warning("Order id_order=%s is stateless but could not be safely resolved. Flagging for review.", id_order)
            continue
        log.info("Order id_order=%s stateless. %s id_order_state=%s",
                  id_order, "would backfill to" if DRY_RUN else "backfilling to", resolved)
        if not DRY_RUN:
            backfill_via_history(id_order, resolved)
            repaired += 1
    log.info("Done. %d stateless order(s) found, %d repaired. DRY_RUN=%s", flagged, repaired, DRY_RUN)


if __name__ == "__main__":
    run()
