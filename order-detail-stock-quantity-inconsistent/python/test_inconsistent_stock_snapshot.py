from check_order_detail_stock import is_stock_quantity_inconsistent


def test_ordered_one_but_in_stock_zero_is_inconsistent():
    assert is_stock_quantity_inconsistent(1, 0) is True


def test_ordered_one_and_in_stock_one_is_consistent():
    assert is_stock_quantity_inconsistent(1, 1) is False


def test_ordered_two_one_refunded_in_stock_one_is_consistent():
    assert is_stock_quantity_inconsistent(2, 1, 1) is False


def test_ordered_two_one_refunded_in_stock_zero_is_inconsistent():
    assert is_stock_quantity_inconsistent(2, 0, 1) is True


def test_zero_quantity_ordered_is_never_inconsistent():
    assert is_stock_quantity_inconsistent(0, 0) is False


def test_negative_quantity_ordered_is_never_inconsistent():
    assert is_stock_quantity_inconsistent(-1, 0) is False


def test_fully_refunded_line_matching_in_stock_is_consistent():
    assert is_stock_quantity_inconsistent(3, 0, 3) is False


def test_in_stock_higher_than_ordered_is_still_inconsistent():
    assert is_stock_quantity_inconsistent(1, 2) is True
