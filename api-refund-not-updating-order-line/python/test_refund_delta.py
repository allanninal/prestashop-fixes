from fix_api_refund_quantity import compute_refund_delta


def test_matching_quantities_need_nothing():
    result = compute_refund_delta(2, [2])
    assert result["expected"] == 2
    assert result["delta"] == 0
    assert result["needs_repair"] is False
    assert result["needs_review"] is False


def test_stale_stored_quantity_needs_repair():
    result = compute_refund_delta(0, [3])
    assert result["expected"] == 3
    assert result["delta"] == 3
    assert result["needs_repair"] is True
    assert result["needs_review"] is False


def test_multiple_credit_slips_sum_together():
    result = compute_refund_delta(1, [1, 2])
    assert result["expected"] == 3
    assert result["delta"] == 2
    assert result["needs_repair"] is True


def test_stored_higher_than_slips_needs_review():
    result = compute_refund_delta(5, [2])
    assert result["expected"] == 2
    assert result["delta"] == -3
    assert result["needs_repair"] is False
    assert result["needs_review"] is True


def test_no_credit_slips_means_zero_expected():
    result = compute_refund_delta(0, [])
    assert result["expected"] == 0
    assert result["delta"] == 0
    assert result["needs_repair"] is False
    assert result["needs_review"] is False


def test_delta_is_zero_when_stored_equals_expected_across_lines():
    result = compute_refund_delta(4, [1, 1, 2])
    assert result["expected"] == 4
    assert result["delta"] == 0
    assert result["needs_repair"] is False
    assert result["needs_review"] is False
