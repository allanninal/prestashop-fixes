from decimal import Decimal

from check_credit_slip_voucher import expected_refund_amount, is_slip_overstated


def test_full_refund_with_no_voucher_matches_line_total():
    lines = [{"qty_ordered": 2, "qty_refunded": 2, "line_total_tax_incl": Decimal("100.00")}]
    result = expected_refund_amount(lines, Decimal("0"), Decimal("100.00"))
    assert result == Decimal("100.00")


def test_full_refund_with_voucher_prorates_the_discount():
    # order total 100, a 10 voucher was applied, so a full refund should be 90
    lines = [{"qty_ordered": 1, "qty_refunded": 1, "line_total_tax_incl": Decimal("100.00")}]
    result = expected_refund_amount(lines, Decimal("10.00"), Decimal("100.00"))
    assert result == Decimal("90.00")


def test_partial_refund_prorates_both_quantity_and_voucher():
    # 2 of 4 units refunded on a 200 line, with a 20 voucher on a 200 order
    lines = [{"qty_ordered": 4, "qty_refunded": 2, "line_total_tax_incl": Decimal("200.00")}]
    result = expected_refund_amount(lines, Decimal("20.00"), Decimal("200.00"))
    # gross prorated = 100.00, discount_ratio = 0.10, expected = 90.00
    assert result == Decimal("90.00")


def test_zero_qty_ordered_line_contributes_nothing():
    lines = [{"qty_ordered": 0, "qty_refunded": 0, "line_total_tax_incl": Decimal("50.00")}]
    result = expected_refund_amount(lines, Decimal("0"), Decimal("50.00"))
    assert result == Decimal("0.00")


def test_zero_products_total_gives_zero_discount_ratio():
    lines = [{"qty_ordered": 1, "qty_refunded": 1, "line_total_tax_incl": Decimal("0.00")}]
    result = expected_refund_amount(lines, Decimal("5.00"), Decimal("0"))
    assert result == Decimal("0.00")


def test_shipping_refund_is_added_after_the_discount():
    lines = [{"qty_ordered": 1, "qty_refunded": 1, "line_total_tax_incl": Decimal("100.00")}]
    result = expected_refund_amount(lines, Decimal("10.00"), Decimal("100.00"), shipping_refund_tax_incl=Decimal("5.00"))
    assert result == Decimal("95.00")


def test_multiple_lines_prorate_independently():
    lines = [
        {"qty_ordered": 2, "qty_refunded": 1, "line_total_tax_incl": Decimal("100.00")},
        {"qty_ordered": 1, "qty_refunded": 1, "line_total_tax_incl": Decimal("100.00")},
    ]
    # gross prorated = 50 + 100 = 150, order total before discount = 200, voucher = 20
    # discount_ratio = 0.10, expected = 150 * 0.90 = 135.00
    result = expected_refund_amount(lines, Decimal("20.00"), Decimal("200.00"))
    assert result == Decimal("135.00")


def test_slip_matching_expected_is_not_overstated():
    assert is_slip_overstated(Decimal("90.00"), Decimal("90.00")) is False


def test_slip_within_tolerance_is_not_overstated():
    assert is_slip_overstated(Decimal("90.01"), Decimal("90.00")) is False


def test_slip_ignoring_voucher_is_overstated():
    # slip totaled the gross line instead of the net amount after the voucher
    assert is_slip_overstated(Decimal("100.00"), Decimal("90.00")) is True


def test_slip_undercharged_is_not_flagged_as_overstated():
    assert is_slip_overstated(Decimal("80.00"), Decimal("90.00")) is False


def test_custom_tolerance_is_respected():
    assert is_slip_overstated(Decimal("90.03"), Decimal("90.00"), tolerance=Decimal("0.05")) is False
