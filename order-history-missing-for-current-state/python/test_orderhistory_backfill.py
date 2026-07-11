from check_order_history import needs_history_backfill


def test_empty_history_needs_backfill():
    result = needs_history_backfill(2, [])
    assert result == {"reason": "no_history", "expected_state": 2}


def test_matching_latest_state_is_consistent():
    history = [(1, "2026-07-01 10:00:00"), (2, "2026-07-02 10:00:00")]
    assert needs_history_backfill(2, history) is None


def test_mismatched_latest_state_needs_backfill():
    history = [(1, "2026-07-01 10:00:00"), (2, "2026-07-02 10:00:00")]
    result = needs_history_backfill(3, history)
    assert result == {
        "reason": "state_mismatch",
        "expected_state": 3,
        "last_recorded_state": 2,
        "last_recorded_date": "2026-07-02 10:00:00",
    }


def test_uses_latest_by_date_regardless_of_input_order():
    history = [(2, "2026-07-02 10:00:00"), (1, "2026-07-01 10:00:00"), (5, "2026-07-05 10:00:00")]
    result = needs_history_backfill(5, history)
    assert result is None


def test_single_history_row_matching_is_consistent():
    assert needs_history_backfill(1, [(1, "2026-07-01 10:00:00")]) is None


def test_single_history_row_mismatched_needs_backfill():
    result = needs_history_backfill(4, [(1, "2026-07-01 10:00:00")])
    assert result["reason"] == "state_mismatch"
    assert result["last_recorded_state"] == 1


def test_no_history_expected_state_matches_current_state():
    result = needs_history_backfill(7, [])
    assert result["expected_state"] == 7
