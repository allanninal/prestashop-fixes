from fix_stale_current_state import compute_correct_current_state


def row(id, id_order_state, date_add):
    return {"id": id, "id_order_state": id_order_state, "date_add": date_add}


def test_empty_history_returns_none():
    assert compute_correct_current_state([]) is None


def test_single_row_returns_its_state():
    assert compute_correct_current_state([row(1, 2, "2026-07-01 10:00:00")]) == 2


def test_picks_most_recent_by_date_add():
    rows = [row(1, 1, "2026-07-01 10:00:00"), row(2, 2, "2026-07-05 10:00:00")]
    assert compute_correct_current_state(rows) == 2


def test_out_of_order_input_still_picks_latest():
    rows = [row(3, 5, "2026-07-09 10:00:00"), row(1, 1, "2026-07-01 10:00:00"), row(2, 2, "2026-07-05 10:00:00")]
    assert compute_correct_current_state(rows) == 5


def test_tie_on_date_add_breaks_by_highest_id():
    rows = [row(10, 3, "2026-07-05 10:00:00"), row(11, 4, "2026-07-05 10:00:00")]
    assert compute_correct_current_state(rows) == 4


def test_row_with_missing_date_add_sorts_first():
    rows = [row(1, 9, None), row(2, 2, "2026-07-01 10:00:00")]
    assert compute_correct_current_state(rows) == 2


def test_identical_date_add_and_id_are_stable():
    rows = [row(7, 3, "2026-07-05 10:00:00"), row(7, 3, "2026-07-05 10:00:00")]
    assert compute_correct_current_state(rows) == 3


def test_many_rows_all_same_date_breaks_by_max_id():
    rows = [row(1, 1, "2026-07-05 10:00:00"), row(5, 9, "2026-07-05 10:00:00"), row(3, 4, "2026-07-05 10:00:00")]
    assert compute_correct_current_state(rows) == 9
