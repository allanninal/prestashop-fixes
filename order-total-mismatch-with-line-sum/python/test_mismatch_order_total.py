from check_order_total import diff_order_total


def test_matching_totals_are_consistent():
    result = diff_order_total(110.00, [50.00, 50.00], 10.00, 0.00)
    assert result["computed_total"] == 110.00
    assert result["diff"] == 0.00
    assert result["mismatched"] is False


def test_tiny_rounding_difference_is_consistent():
    result = diff_order_total(110.01, [50.00, 50.00], 10.00, 0.00)
    assert result["mismatched"] is False


def test_missing_line_is_flagged():
    result = diff_order_total(110.00, [50.00], 10.00, 0.00)
    assert result["computed_total"] == 60.00
    assert result["diff"] == 50.00
    assert result["mismatched"] is True


def test_discount_reduces_computed_total():
    result = diff_order_total(90.00, [50.00, 50.00], 10.00, 20.00)
    assert result["computed_total"] == 90.00
    assert result["mismatched"] is False


def test_stale_total_after_edit_is_flagged():
    result = diff_order_total(150.00, [50.00, 50.00], 10.00, 0.00)
    assert result["computed_total"] == 110.00
    assert result["diff"] == 40.00
    assert result["mismatched"] is True


def test_custom_epsilon_is_respected():
    result = diff_order_total(110.03, [50.00, 50.00], 10.00, 0.00, epsilon=0.05)
    assert result["mismatched"] is False


def test_no_lines_uses_shipping_and_discounts_only():
    result = diff_order_total(10.00, [], 10.00, 0.00)
    assert result["computed_total"] == 10.00
    assert result["mismatched"] is False


def test_overpaid_total_is_flagged_positive_diff():
    result = diff_order_total(200.00, [50.00, 50.00], 10.00, 0.00)
    assert result["diff"] == 90.00
    assert result["mismatched"] is True
