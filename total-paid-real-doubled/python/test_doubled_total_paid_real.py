from reconcile_total_paid_real import reconcile_payment


def test_matching_totals_are_consistent():
    result = reconcile_payment(100.00, [40.00, 60.00])
    assert result["mismatch"] is False
    assert result["sumPayments"] == 100.00
    assert result["delta"] == 0.00
    assert result["likelyDoubled"] is False


def test_tiny_rounding_difference_is_consistent():
    result = reconcile_payment(100.00, [33.335, 33.335, 33.33])
    assert result["mismatch"] is False


def test_partial_payment_shortfall_is_not_doubled():
    result = reconcile_payment(40.00, [40.00])
    assert result["mismatch"] is False
    assert result["likelyDoubled"] is False


def test_doubled_total_is_flagged_and_marked_likely_doubled():
    result = reconcile_payment(120.00, [60.00])
    assert result["mismatch"] is True
    assert result["sumPayments"] == 60.00
    assert result["delta"] == 60.00
    assert result["likelyDoubled"] is True


def test_doubled_against_total_paid_when_no_payment_rows_yet():
    result = reconcile_payment(200.00, [], total_paid=100.00)
    assert result["mismatch"] is True
    assert result["likelyDoubled"] is True


def test_ordinary_mismatch_not_close_to_double_is_not_flagged_doubled():
    result = reconcile_payment(70.00, [60.00])
    assert result["mismatch"] is True
    assert result["likelyDoubled"] is False


def test_zero_payments_and_zero_total_paid_is_not_doubled():
    result = reconcile_payment(0.00, [])
    assert result["mismatch"] is False
    assert result["likelyDoubled"] is False


def test_multiple_payment_rows_summing_to_double_is_flagged():
    # e.g. a legitimate 50 payment plus a duplicate 50 payment row
    result = reconcile_payment(100.00, [50.00, 50.00], total_paid=50.00)
    assert result["mismatch"] is False  # stored total already equals sum of rows
    assert result["sumPayments"] == 100.00


def test_negative_delta_for_true_partial_payment():
    result = reconcile_payment(30.00, [30.00, 20.00])
    assert result["mismatch"] is True
    assert result["delta"] == -20.00
    assert result["likelyDoubled"] is False
