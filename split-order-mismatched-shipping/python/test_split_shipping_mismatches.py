from check_split_shipping import find_shipping_mismatches, reconcile_reference_total


def order(**over):
    base = {"id": 101, "reference": "ABCDEFGHI", "id_carrier": 3,
            "total_shipping_tax_incl": "5.00", "total_paid_tax_incl": "55.00"}
    base.update(over)
    return base


def carrier_row(**over):
    base = {"id_order": 101, "id_carrier": 3, "shipping_cost_tax_incl": "5.00", "id_order_invoice": 1}
    base.update(over)
    return base


def test_no_mismatch_when_everything_agrees():
    result = find_shipping_mismatches([order()], [carrier_row()])
    assert result == []


def test_missing_carrier_row_with_nonzero_shipping_is_flagged():
    result = find_shipping_mismatches([order(id_carrier=0)], [])
    assert len(result) == 1
    assert result[0]["reason"] == "missing_carrier_with_nonzero_shipping"


def test_zero_shipping_but_carrier_row_has_cost_is_flagged():
    o = order(id_carrier=0, total_shipping_tax_incl="0.00")
    result = find_shipping_mismatches([o], [carrier_row()])
    assert len(result) == 1
    assert result[0]["reason"] == "zero_shipping_with_carrier_assigned"


def test_carrier_id_mismatch_is_flagged():
    result = find_shipping_mismatches([order(id_carrier=7)], [carrier_row(id_carrier=3)])
    assert len(result) == 1
    assert result[0]["reason"] == "carrier_id_mismatch"


def test_shipping_cost_mismatch_is_flagged():
    result = find_shipping_mismatches([order(total_shipping_tax_incl="12.00")], [carrier_row(shipping_cost_tax_incl="5.00")])
    assert len(result) == 1
    assert result[0]["reason"] == "shipping_cost_mismatch"


def test_small_rounding_difference_is_not_flagged():
    result = find_shipping_mismatches([order(total_shipping_tax_incl="5.004")], [carrier_row(shipping_cost_tax_incl="5.00")])
    assert result == []


def test_order_with_no_carriers_and_zero_shipping_is_not_flagged():
    result = find_shipping_mismatches([order(id_carrier=0, total_shipping_tax_incl="0.00")], [])
    assert result == []


def test_reconcile_reference_total_matches():
    orders = [
        order(id=101, total_products_wt="50.00", total_shipping_tax_incl="5.00",
              total_discounts_tax_incl="0.00", total_paid_tax_incl="55.00"),
        order(id=102, total_products_wt="20.00", total_shipping_tax_incl="8.00",
              total_discounts_tax_incl="0.00", total_paid_tax_incl="28.00"),
    ]
    sum_paid, expected = reconcile_reference_total(orders)
    assert sum_paid == 83.00
    assert expected == 83.00


def test_reconcile_reference_total_detects_mismatch():
    # Split logic dropped the freight order's shipping onto the courier order instead.
    orders = [
        order(id=101, total_products_wt="50.00", total_shipping_tax_incl="0.00",
              total_discounts_tax_incl="0.00", total_paid_tax_incl="60.00"),
        order(id=102, total_products_wt="20.00", total_shipping_tax_incl="13.00",
              total_discounts_tax_incl="0.00", total_paid_tax_incl="33.00"),
    ]
    sum_paid, expected = reconcile_reference_total(orders)
    assert sum_paid == 93.00
    assert expected == 83.00
    assert round(sum_paid - expected, 2) == 10.00
