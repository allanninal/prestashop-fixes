from negative_quantity_backorder import clamp_negative_stock


def test_noop_when_quantity_is_not_negative():
    assert clamp_negative_stock(5, True, 0, False) == (5, "noop")


def test_noop_when_quantity_is_exactly_zero():
    assert clamp_negative_stock(0, True, 1, False) == (0, "noop")


def test_flag_when_not_tracked_by_depends_on_stock():
    assert clamp_negative_stock(-2, False, 0, False) == (-2, "flag_manual_review")


def test_flag_when_backorders_allowed_and_real_demand_open():
    assert clamp_negative_stock(-4, True, 1, True) == (-4, "flag_manual_review")


def test_clamp_when_backorders_denied():
    assert clamp_negative_stock(-3, True, 0, False) == (0, "clamp_to_zero")


def test_clamp_when_backorders_allowed_but_no_open_backorder_paid_order():
    assert clamp_negative_stock(-1, True, 1, False) == (0, "clamp_to_zero")


def test_clamp_when_global_default_policy_and_no_open_demand():
    assert clamp_negative_stock(-7, True, 2, False) == (0, "clamp_to_zero")


def test_clamp_when_global_default_policy_and_open_demand_still_clamps():
    # out_of_stock_policy == 2 (global default) is not explicit backorder allow (1),
    # so even with an open backorder-paid order this is treated as drift, not demand.
    assert clamp_negative_stock(-5, True, 2, True) == (0, "clamp_to_zero")


def test_not_tracked_takes_priority_over_backorder_demand():
    # depends_on_stock False always short-circuits to flag_manual_review, regardless
    # of policy or open demand, since the value is meaningless for decrement purposes.
    assert clamp_negative_stock(-9, False, 1, True) == (-9, "flag_manual_review")
