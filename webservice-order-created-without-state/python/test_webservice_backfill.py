from backfill_stateless_orders import resolve_backfill_state

STATES = [
    {"id": "1", "name": "Awaiting check payment", "logable": "1", "hidden": "0"},
    {"id": "2", "name": "Payment accepted", "logable": "1", "hidden": "0"},
    {"id": "3", "name": "Awaiting bank wire payment", "logable": "1", "hidden": "0"},
    {"id": "6", "name": "Canceled", "logable": "0", "hidden": "0"},
    {"id": "7", "name": "Refunded", "logable": "0", "hidden": "1"},
]


def order(**over):
    base = {"id_order": 42, "current_state": 0, "total_paid": 100.0, "total_paid_real": 0.0,
            "payment": "Bank wire", "valid": False}
    base.update(over)
    return base


def test_returns_none_when_current_state_is_already_set():
    assert resolve_backfill_state(order(current_state=2), STATES) is None


def test_resolves_paid_state_when_fully_paid():
    assert resolve_backfill_state(order(total_paid_real=100.0), STATES) == 2


def test_resolves_paid_state_when_overpaid():
    assert resolve_backfill_state(order(total_paid_real=105.0), STATES) == 2


def test_resolves_lowest_awaiting_state_when_unpaid():
    assert resolve_backfill_state(order(), STATES) == 1


def test_returns_none_when_no_awaiting_states_exist():
    no_awaiting = [s for s in STATES if "wire" not in s["name"].lower() and "check" not in s["name"].lower()]
    assert resolve_backfill_state(order(), no_awaiting) is None


def test_returns_none_when_no_logable_states_exist():
    hidden_only = [dict(s, logable="0") for s in STATES]
    assert resolve_backfill_state(order(total_paid_real=100.0), hidden_only) is None


def test_returns_none_when_current_state_is_zero_and_no_states_given():
    assert resolve_backfill_state(order(current_state=0), []) is None


def test_zero_total_paid_falls_back_to_awaiting():
    assert resolve_backfill_state(order(total_paid=0.0, total_paid_real=0.0), STATES) == 1


def test_returns_none_when_multiple_paid_states_match():
    ambiguous = STATES + [{"id": "8", "name": "Payment accepted by proxy", "logable": "1", "hidden": "0"}]
    assert resolve_backfill_state(order(total_paid_real=100.0), ambiguous) is None
