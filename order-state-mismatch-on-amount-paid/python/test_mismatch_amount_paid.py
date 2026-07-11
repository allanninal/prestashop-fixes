from check_amount_mismatch import amount_mismatch

PAID_STATES = {2, 5}


def test_matching_amounts_are_consistent():
    assert amount_mismatch(100.00, 100.00, 2, PAID_STATES) is None


def test_tiny_rounding_difference_is_consistent():
    assert amount_mismatch(99.995, 100.00, 2, PAID_STATES) is None


def test_partial_payment_is_flagged():
    result = amount_mismatch(100.00, 40.00, 1, PAID_STATES)
    assert result["reason"] == "amount_mismatch"
    assert result["difference"] == -60.00
    assert result["current_state_is_paid"] is False


def test_mismatch_on_a_state_flagged_as_paid_is_urgent():
    result = amount_mismatch(100.00, 40.00, 2, PAID_STATES)
    assert result["current_state_is_paid"] is True


def test_overpayment_is_flagged():
    result = amount_mismatch(100.00, 150.00, 5, PAID_STATES)
    assert result["difference"] == 50.00
    assert result["current_state_is_paid"] is True


def test_state_not_in_paid_set_is_not_urgent():
    result = amount_mismatch(100.00, 40.00, 9, PAID_STATES)
    assert result["current_state_is_paid"] is False
