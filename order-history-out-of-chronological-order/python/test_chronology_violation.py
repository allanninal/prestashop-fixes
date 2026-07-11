from chronology_audit import find_chronology_violation


def row(id, id_order_state, date_add):
    return {"id": id, "id_order_state": id_order_state, "date_add": date_add}


def test_no_rows_no_violation():
    assert find_chronology_violation([], 2) is None


def test_agreeing_current_state_no_violation():
    rows = [row(1, 1, "2026-07-10 10:00:00"), row(2, 2, "2026-07-10 10:05:00")]
    assert find_chronology_violation(rows, 2) is None


def test_current_state_mismatch_detected():
    rows = [row(1, 1, "2026-07-10 10:00:00"), row(2, 3, "2026-07-10 10:05:00")]
    result = find_chronology_violation(rows, 2)
    assert result["reason"] == "current_state_mismatch"
    assert result["latest_history_state"] == 3
    assert result["current_state"] == 2
    assert result["latest_id"] == 2


def test_id_used_as_tiebreaker_to_pick_latest_state():
    # Same date_add: id determines the true latest row (id 6, state 4), so
    # current_state=4 matches the tiebreak-selected latest row. But since the
    # two rows also share an identical date_add with differing states, that is
    # itself flagged as an ambiguous-order case for manual review.
    rows = [row(5, 3, "2026-07-10 10:00:00"), row(6, 4, "2026-07-10 10:00:00")]
    result = find_chronology_violation(rows, 4)
    assert result["reason"] == "duplicate_timestamp_ambiguous_order"


def test_duplicate_timestamp_ambiguous_order_flagged():
    rows = [row(5, 3, "2026-07-10 10:00:00"), row(6, 4, "2026-07-10 10:00:00")]
    result = find_chronology_violation(rows, 3)
    assert result["reason"] == "current_state_mismatch"


def test_duplicate_timestamp_flagged_even_when_state_agrees_elsewhere():
    rows = [
        row(1, 1, "2026-07-10 09:00:00"),
        row(2, 2, "2026-07-10 10:00:00"),
        row(3, 5, "2026-07-10 10:00:00"),
    ]
    result = find_chronology_violation(rows, 5)
    assert result["reason"] == "duplicate_timestamp_ambiguous_order"
    assert len(result["rows"]) == 2


def test_out_of_input_order_rows_are_sorted_correctly():
    # Rows passed in scrambled order should still resolve to the true latest by (date_add, id).
    rows = [
        row(3, 6, "2026-07-10 11:00:00"),
        row(1, 4, "2026-07-10 09:00:00"),
        row(2, 5, "2026-07-10 10:00:00"),
    ]
    assert find_chronology_violation(rows, 6) is None
    result = find_chronology_violation(rows, 5)
    assert result["reason"] == "current_state_mismatch"
    assert result["latest_history_state"] == 6
    assert result["latest_id"] == 3


def test_single_row_matching_current_state_no_violation():
    rows = [row(1, 2, "2026-07-10 09:00:00")]
    assert find_chronology_violation(rows, 2) is None


def test_single_row_mismatched_current_state_is_violation():
    rows = [row(1, 2, "2026-07-10 09:00:00")]
    result = find_chronology_violation(rows, 9)
    assert result["reason"] == "current_state_mismatch"
    assert result["latest_id"] == 1
