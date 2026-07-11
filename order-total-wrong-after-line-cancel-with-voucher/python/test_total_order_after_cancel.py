from check_order_total_after_cancel import recompute_order_total


def line(**over):
    base = {"total_price_tax_incl": "50.00"}
    base.update(over)
    return base


def rule(**over):
    base = {"value": "10.00", "value_tax_excl": "8.33", "deleted": "0"}
    base.update(over)
    return base


def test_matches_when_totals_agree():
    lines = [line(total_price_tax_incl="90.00")]
    rules = [rule(value="10.00", value_tax_excl="8.33")]
    result = recompute_order_total(lines, rules, "5.00", "85.00")
    assert result["is_mismatched"] is False
    assert result["invalid_discount_shape"] is False


def test_mismatched_after_line_cancelled_voucher_stale():
    # One line remains (50.00) plus shipping (5.00), minus a 20.00 voucher that was
    # sized for the original two-line cart: expected is 50 + 5 - 20 = 35.00, but the
    # order still reports the pre-cancel total of 75.00 because total_paid was never
    # recalculated after the cancel.
    lines = [line(total_price_tax_incl="50.00")]
    rules = [rule(value="20.00", value_tax_excl="16.67")]
    reported_total = "75.00"  # stale: still reflects the order before the line was cancelled
    result = recompute_order_total(lines, rules, "5.00", reported_total)
    assert result["is_mismatched"] is True
    assert result["delta"] != 0


def test_no_voucher_no_mismatch():
    lines = [line(total_price_tax_incl="50.00")]
    result = recompute_order_total(lines, [], "5.00", "55.00")
    assert result["is_mismatched"] is False


def test_stacked_vouchers_summed_together():
    lines = [line(total_price_tax_incl="100.00")]
    rules = [rule(value="10.00", value_tax_excl="8.33"), rule(value="5.00", value_tax_excl="4.17")]
    result = recompute_order_total(lines, rules, "0.00", "85.00")
    assert result["is_mismatched"] is False


def test_free_shipping_voucher_zeroes_shipping_reduction():
    lines = [line(total_price_tax_incl="60.00")]
    rules = [rule(value="8.00", value_tax_excl="8.00")]  # models shipping value reduced to 0
    result = recompute_order_total(lines, rules, "8.00", "60.00")
    assert result["is_mismatched"] is False


def test_deleted_cart_rule_excluded_from_sum():
    lines = [line(total_price_tax_incl="90.00")]
    rules = [rule(value="10.00", deleted="1"), rule(value="5.00", value_tax_excl="4.17", deleted="0")]
    result = recompute_order_total(lines, rules, "0.00", "85.00")
    assert result["is_mismatched"] is False


def test_within_tolerance_not_mismatched():
    lines = [line(total_price_tax_incl="90.00")]
    rules = [rule(value="10.00", value_tax_excl="8.33")]
    result = recompute_order_total(lines, rules, "5.00", "85.01")
    assert result["is_mismatched"] is False


def test_negative_cart_rule_value_is_invalid_shape():
    lines = [line(total_price_tax_incl="90.00")]
    rules = [rule(value="-10.00", value_tax_excl="-8.33")]
    result = recompute_order_total(lines, rules, "0.00", "100.00")
    assert result["invalid_discount_shape"] is True


def test_tax_excl_greater_than_tax_incl_is_invalid_shape():
    lines = [line(total_price_tax_incl="90.00")]
    rules = [rule(value="10.00", value_tax_excl="12.00")]
    result = recompute_order_total(lines, rules, "0.00", "80.00")
    assert result["invalid_discount_shape"] is True
