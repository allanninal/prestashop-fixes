from reconcile_payment_error import decide_order_payment_repair


def order(**over):
    base = {"id": 101, "total_paid": 100.00, "total_paid_real": 0.0, "current_state": 8}
    base.update(over)
    return base


def test_totals_reconciled_when_everything_matches():
    result = decide_order_payment_repair(order(), {"amount": 100.00}, 100.00)
    assert result["action"] == "none"
    assert result["reason"] == "totals_reconciled"


def test_flags_missing_order_payment_row():
    result = decide_order_payment_repair(order(), None, 100.00)
    assert result["action"] == "flag_manual_review"
    assert result["reason"] == "no_order_payment_row_found"


def test_flags_when_order_total_diverges_from_cart():
    # total_paid (100) does not match the recomputed cart total (85), a missed shipping line
    result = decide_order_payment_repair(order(total_paid=100.00), {"amount": 100.00}, 85.00)
    assert result["action"] == "flag_manual_review"
    assert result["reason"] == "order_total_paid_diverges_from_cart_total"


def test_corrects_payment_amount_when_order_total_is_right_but_payment_row_is_not():
    result = decide_order_payment_repair(order(total_paid=100.00), {"amount": 40.00}, 100.00)
    assert result["action"] == "correct_payment_amount"
    assert result["corrected_amount"] == 100.00


def test_tiny_rounding_within_precision_is_treated_as_equal():
    result = decide_order_payment_repair(order(total_paid=100.004), {"amount": 100.00}, 100.001)
    assert result["action"] == "none"


def test_respects_custom_precision():
    result = decide_order_payment_repair(order(total_paid=100.0), {"amount": 100.0}, 100.0, precision=0)
    assert result["action"] == "none"


def test_overpayment_on_matching_order_total_is_corrected():
    result = decide_order_payment_repair(order(total_paid=100.00), {"amount": 150.00}, 100.00)
    assert result["action"] == "correct_payment_amount"
    assert result["corrected_amount"] == 100.00


def test_negative_difference_diverging_from_cart_is_flagged_not_corrected():
    result = decide_order_payment_repair(order(total_paid=120.00), {"amount": 120.00}, 100.00)
    assert result["action"] == "flag_manual_review"
