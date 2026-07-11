from check_refund_overage import is_refund_overage, would_new_refund_overshoot


def test_exact_match_is_not_overage():
    result = is_refund_overage(2, 2, 100.00, 100.00)
    assert result["overage"] is False
    assert result["quantity_overage"] == 0
    assert result["amount_overage"] == 0.0


def test_one_cent_rounding_is_not_overage():
    result = is_refund_overage(2, 2, 100.00, 100.01)
    assert result["overage"] is False


def test_quantity_overage_is_flagged():
    result = is_refund_overage(2, 3, 100.00, 100.00)
    assert result["overage"] is True
    assert result["quantity_overage"] == 1
    assert result["amount_overage"] == 0.0


def test_amount_overage_is_flagged():
    result = is_refund_overage(2, 2, 100.00, 150.00)
    assert result["overage"] is True
    assert result["quantity_overage"] == 0
    assert result["amount_overage"] == 50.00


def test_zero_quantity_line_with_refund_is_flagged():
    result = is_refund_overage(0, 1, 0.00, 25.00)
    assert result["overage"] is True
    assert result["quantity_overage"] == 1
    assert result["amount_overage"] == 25.00


def test_negative_refunded_amount_is_not_overage():
    result = is_refund_overage(2, 0, 100.00, -10.00)
    assert result["overage"] is False
    assert result["amount_overage"] == 0.0


def test_custom_epsilon_is_respected():
    result = is_refund_overage(2, 2, 100.00, 100.03, epsilon=0.05)
    assert result["overage"] is False


def test_both_quantity_and_amount_overage_are_reported_together():
    result = is_refund_overage(1, 2, 50.00, 120.00)
    assert result["overage"] is True
    assert result["quantity_overage"] == 1
    assert result["amount_overage"] == 70.00


def test_guard_rejects_request_over_remaining_quantity():
    assert would_new_refund_overshoot(2, 1, 100.00, 50.00, 2, 50.00) is True


def test_guard_rejects_request_over_remaining_amount():
    assert would_new_refund_overshoot(2, 0, 100.00, 0.00, 1, 150.00) is True


def test_guard_allows_request_within_remaining_balance():
    assert would_new_refund_overshoot(2, 1, 100.00, 50.00, 1, 50.00) is False


def test_guard_allows_exact_remaining_balance_within_epsilon():
    assert would_new_refund_overshoot(2, 0, 100.00, 0.00, 2, 100.00) is False
