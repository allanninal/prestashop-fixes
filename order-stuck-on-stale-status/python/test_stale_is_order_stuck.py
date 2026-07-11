from order_stuck_on_stale_status import is_order_stuck

TERMINAL = {5, 6, 7, 8}  # Delivered, Canceled, Refunded, Payment error
NOW = "2026-07-10T00:00:00+00:00"


def test_flags_order_stuck_when_state_matches_history_and_stale():
    assert is_order_stuck(2, 2, "2026-06-20T00:00:00+00:00", NOW, TERMINAL, 5) is True


def test_not_stuck_when_state_is_terminal():
    assert is_order_stuck(6, 6, "2026-06-20T00:00:00+00:00", NOW, TERMINAL, 5) is False


def test_not_stuck_when_recent():
    assert is_order_stuck(2, 2, "2026-07-08T00:00:00+00:00", NOW, TERMINAL, 5) is False


def test_not_stuck_when_history_disagrees_with_current_state():
    # order_histories advanced to state 3 but orders.current_state is still 2:
    # this is a desync, not a stall, so it should not be flagged as "stuck"
    assert is_order_stuck(2, 3, "2026-06-20T00:00:00+00:00", NOW, TERMINAL, 5) is False


def test_exactly_at_threshold_is_not_flagged():
    assert is_order_stuck(2, 2, "2026-07-05T00:00:00+00:00", NOW, TERMINAL, 5) is False


def test_one_day_past_threshold_is_flagged():
    assert is_order_stuck(2, 2, "2026-07-04T00:00:00+00:00", NOW, TERMINAL, 5) is True


def test_custom_threshold_is_respected():
    assert is_order_stuck(2, 2, "2026-07-08T00:00:00+00:00", NOW, TERMINAL, 1) is True


def test_terminal_state_short_circuits_even_when_stale_and_matching():
    assert is_order_stuck(7, 7, "2026-01-01T00:00:00+00:00", NOW, TERMINAL, 5) is False
