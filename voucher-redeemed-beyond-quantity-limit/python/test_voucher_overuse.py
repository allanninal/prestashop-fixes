from audit_voucher_overuse import find_voucher_overuse

RULE = {"id": 42, "code": "SUMMER1", "quantity": 1, "quantity_per_user": 1}


def order(**over):
    base = {"id_order": 1, "id_customer": 10, "current_state": 2, "date_add": "2026-07-01 10:00:00"}
    base.update(over)
    return base


def test_no_overage_when_single_use_within_quantity():
    orders = [order()]
    assert find_voucher_overuse(RULE, orders) is None


def test_overage_when_quantity_one_used_twice():
    orders = [order(id_order=1, id_customer=10), order(id_order=2, id_customer=11)]
    result = find_voucher_overuse(RULE, orders)
    assert result is not None
    assert result["overage_count"] == 1
    assert result["total_uses"] == 2
    assert result["offending_order_ids"] == [1, 2]


def test_per_user_violation_flagged_even_under_total_quantity():
    rule = {"id": 7, "code": "VIP5", "quantity": 5, "quantity_per_user": 1}
    orders = [order(id_order=1, id_customer=10), order(id_order=2, id_customer=10)]
    result = find_voucher_overuse(rule, orders)
    assert result is not None
    assert result["per_user_violations"] == {10: 2}
    assert result["overage_count"] == 0


def test_no_flag_when_orders_empty():
    assert find_voucher_overuse(RULE, []) is None


def test_offending_order_ids_are_sorted():
    orders = [order(id_order=5, id_customer=1), order(id_order=2, id_customer=2), order(id_order=9, id_customer=3)]
    rule = {"id": 8, "code": "X", "quantity": 1, "quantity_per_user": 1}
    result = find_voucher_overuse(rule, orders)
    assert result["offending_order_ids"] == [2, 5, 9]


def test_guest_orders_without_customer_id_are_grouped_together():
    orders = [order(id_order=1, id_customer=None), order(id_order=2, id_customer=None)]
    rule = {"id": 9, "code": "GUEST1", "quantity": 5, "quantity_per_user": 1}
    result = find_voucher_overuse(rule, orders)
    assert result is not None
    assert result["per_user_violations"] == {None: 2}


def test_exactly_at_quantity_limit_is_not_overage():
    rule = {"id": 10, "code": "EXACT", "quantity": 2, "quantity_per_user": 2}
    orders = [order(id_order=1, id_customer=10), order(id_order=2, id_customer=11)]
    assert find_voucher_overuse(rule, orders) is None


def test_cancelled_orders_are_not_passed_in_so_they_never_count():
    # orders_using_rule_list is expected to be pre-filtered to valid states already;
    # the pure function only ever sees what it is given.
    orders = [order(id_order=1, id_customer=10)]
    assert find_voucher_overuse(RULE, orders) is None
