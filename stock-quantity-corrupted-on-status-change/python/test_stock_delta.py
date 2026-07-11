from reconcile_stock import expected_stock_delta

NOT_LOGABLE = {"id": 1, "logable": False, "shipped": False}
LOGABLE = {"id": 2, "logable": True, "shipped": False}


def test_becoming_logable_decrements_stock():
    assert expected_stock_delta(NOT_LOGABLE, LOGABLE, 3, [], 2) == -3


def test_leaving_logable_restocks():
    assert expected_stock_delta(LOGABLE, NOT_LOGABLE, 3, [2], 1) == 3


def test_non_logable_to_non_logable_is_a_no_op():
    other_not_logable = {"id": 3, "logable": False, "shipped": False}
    assert expected_stock_delta(NOT_LOGABLE, other_not_logable, 3, [], 3) == 0


def test_duplicate_transition_to_same_state_is_a_no_op():
    assert expected_stock_delta(NOT_LOGABLE, LOGABLE, 3, [2], 2) == 0


def test_logable_to_logable_is_a_no_op():
    other_logable = {"id": 4, "logable": True, "shipped": True}
    assert expected_stock_delta(LOGABLE, other_logable, 3, [2], 4) == 0


def test_duplicate_check_uses_candidate_state_not_from_state():
    # Candidate state id 1 was seen before, even though from_state is different this run.
    assert expected_stock_delta(LOGABLE, NOT_LOGABLE, 5, [1], 1) == 0


def test_line_quantity_of_zero_yields_zero_delta_either_direction():
    assert expected_stock_delta(NOT_LOGABLE, LOGABLE, 0, [], 2) == 0
    assert expected_stock_delta(LOGABLE, NOT_LOGABLE, 0, [2], 1) == 0
