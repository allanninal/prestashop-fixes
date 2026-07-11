from check_order_carrier import classify_order_carrier


VALID = {1, 2, 3}
DELETED = {5, 6}


def test_ok_when_carrier_is_valid():
    assert classify_order_carrier(2, VALID, DELETED) == "ok"


def test_zero_when_carrier_id_is_zero():
    assert classify_order_carrier(0, VALID, DELETED) == "zero"


def test_zero_when_carrier_id_is_none():
    assert classify_order_carrier(None, VALID, DELETED) == "zero"


def test_deleted_when_carrier_is_soft_deleted():
    assert classify_order_carrier(5, VALID, DELETED) == "deleted"


def test_missing_when_carrier_is_in_neither_set():
    assert classify_order_carrier(99, VALID, DELETED) == "missing"


def test_ok_takes_priority_when_id_appears_valid_only():
    assert classify_order_carrier(1, VALID, DELETED) == "ok"


def test_missing_wins_over_deleted_check_when_not_in_either_set_large_id():
    assert classify_order_carrier(1000, VALID, DELETED) == "missing"


def test_deleted_checked_before_missing_for_known_dead_id():
    assert classify_order_carrier(6, VALID, DELETED) == "deleted"
