from check_duplicate_customers import pick_merge_action, normalize_email


def customer(**over):
    base = {
        "id": 1,
        "email": "jane@example.com",
        "is_guest": "0",
        "deleted": "0",
        "date_add": "2026-01-01 10:00:00",
        "order_count": 0,
    }
    base.update(over)
    return base


def test_no_action_for_single_row():
    assert pick_merge_action([customer()]) is None


def test_no_action_when_only_one_active_row():
    rows = [customer(id=1), customer(id=2, deleted="1")]
    assert pick_merge_action(rows) is None


def test_keeps_row_with_more_orders():
    rows = [
        customer(id=1, order_count=0),
        customer(id=2, order_count=5),
    ]
    action = pick_merge_action(rows)
    assert action["keep_id"] == 2
    assert action["duplicate_ids"] == [1]


def test_ties_broken_by_registered_over_guest():
    rows = [
        customer(id=1, is_guest="1", order_count=0),
        customer(id=2, is_guest="0", order_count=0),
    ]
    action = pick_merge_action(rows)
    assert action["keep_id"] == 2
    assert action["duplicate_ids"] == [1]


def test_ties_broken_by_earliest_date_add():
    rows = [
        customer(id=1, date_add="2026-03-01 00:00:00", order_count=0),
        customer(id=2, date_add="2026-01-01 00:00:00", order_count=0),
    ]
    action = pick_merge_action(rows)
    assert action["keep_id"] == 2
    assert action["duplicate_ids"] == [1]


def test_deleted_rows_are_ignored():
    rows = [
        customer(id=1, order_count=3),
        customer(id=2, deleted="1", order_count=9),
        customer(id=3, order_count=1),
    ]
    action = pick_merge_action(rows)
    assert action["keep_id"] == 1
    assert action["duplicate_ids"] == [3]


def test_email_carried_through_from_first_row():
    rows = [customer(id=1, email="Jane@Example.com "), customer(id=2, order_count=1)]
    action = pick_merge_action(rows)
    assert action["email"] == "Jane@Example.com "


def test_normalize_email_lowers_and_trims():
    assert normalize_email("  Jane@Example.COM ") == "jane@example.com"


def test_normalize_email_handles_none():
    assert normalize_email(None) == ""
