from duplicate_history_cleanup import find_duplicate_history_ids


def row(id, id_order_state, date_add):
    return {"id": id, "id_order_state": id_order_state, "date_add": date_add}


def test_no_rows_no_duplicates():
    assert find_duplicate_history_ids([]) == []


def test_no_duplicates_when_all_states_differ():
    rows = [row(1, 1, "2026-07-10 10:00:00"), row(2, 2, "2026-07-10 10:05:00")]
    assert find_duplicate_history_ids(rows) == []


def test_consecutive_same_state_flagged():
    rows = [row(1, 2, "2026-07-10 10:00:00"), row(2, 2, "2026-07-10 10:00:05")]
    assert find_duplicate_history_ids(rows) == [2]


def test_first_occurrence_never_flagged():
    rows = [row(1, 2, "2026-07-10 10:00:00"), row(2, 2, "2026-07-10 10:00:05")]
    duplicate_ids = find_duplicate_history_ids(rows)
    assert 1 not in duplicate_ids


def test_revisiting_same_state_later_is_not_flagged():
    # Awaiting payment -> Payment accepted -> Refunded -> Awaiting payment again.
    rows = [
        row(1, 1, "2026-07-10 09:00:00"),
        row(2, 2, "2026-07-10 09:05:00"),
        row(3, 3, "2026-07-10 09:10:00"),
        row(4, 1, "2026-07-10 09:15:00"),
    ]
    assert find_duplicate_history_ids(rows) == []


def test_run_longer_than_two_flags_all_but_first():
    rows = [
        row(1, 2, "2026-07-10 10:00:00"),
        row(2, 2, "2026-07-10 10:00:01"),
        row(3, 2, "2026-07-10 10:00:02"),
    ]
    assert find_duplicate_history_ids(rows) == [2, 3]


def test_unsorted_input_is_sorted_before_comparing():
    rows = [
        row(2, 2, "2026-07-10 10:00:05"),
        row(1, 2, "2026-07-10 10:00:00"),
    ]
    assert find_duplicate_history_ids(rows) == [2]


def test_three_separate_runs_each_flagged_independently():
    rows = [
        row(1, 1, "2026-07-10 09:00:00"),
        row(2, 1, "2026-07-10 09:00:01"),
        row(3, 2, "2026-07-10 09:05:00"),
        row(4, 2, "2026-07-10 09:05:01"),
    ]
    assert find_duplicate_history_ids(rows) == [2, 4]
