from find_orphaned_orders import find_orphaned_guest_orders, normalize_email


def guest(**over):
    base = {"id": 101, "email": "jane@example.com", "is_guest": "1"}
    base.update(over)
    return base


def real(**over):
    base = {"id": 205, "email": "jane@example.com", "is_guest": "0"}
    base.update(over)
    return base


def order(**over):
    base = {"id": 900, "id_customer": 101, "reference": "ABCDE", "total_paid": "49.90"}
    base.update(over)
    return base


def test_finds_orphaned_order_when_email_matches_both_groups():
    plan = find_orphaned_guest_orders([guest()], [real()], [order()])
    assert plan == [{
        "id_order": 900,
        "current_id_customer": 101,
        "target_id_customer": 205,
        "email": "jane@example.com",
    }]


def test_no_plan_when_email_only_a_guest():
    plan = find_orphaned_guest_orders([guest()], [], [order()])
    assert plan == []


def test_no_plan_when_order_belongs_to_a_different_customer():
    plan = find_orphaned_guest_orders([guest()], [real()], [order(id_customer=999)])
    assert plan == []


def test_ignores_orders_already_on_the_real_account():
    orders = [order(id=900, id_customer=101), order(id=901, id_customer=205)]
    plan = find_orphaned_guest_orders([guest()], [real()], orders)
    assert [p["id_order"] for p in plan] == [900]


def test_multiple_orphaned_orders_for_the_same_guest():
    orders = [order(id=900), order(id=901)]
    plan = find_orphaned_guest_orders([guest()], [real()], orders)
    assert [p["id_order"] for p in plan] == [900, 901]


def test_email_matching_is_case_and_space_insensitive():
    g = guest(email="  Jane@Example.COM ")
    plan = find_orphaned_guest_orders([g], [real()], [order()])
    assert len(plan) == 1
    assert plan[0]["email"] == "jane@example.com"


def test_unrelated_email_pairs_are_ignored():
    other_guest = guest(id=111, email="bob@example.com")
    plan = find_orphaned_guest_orders([other_guest], [real()], [order(id_customer=111)])
    assert plan == []


def test_normalize_email_lowers_and_trims():
    assert normalize_email("  Jane@Example.COM ") == "jane@example.com"


def test_normalize_email_handles_none():
    assert normalize_email(None) == ""
