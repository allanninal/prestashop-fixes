from reconcile_neg_stock_after_order import decide_stock_reconciliation


def test_not_negative_needs_no_fix():
    result = decide_stock_reconciliation(5, 1, 1, True)
    assert result["needs_fix"] is False
    assert result["new_quantity"] is None
    assert result["reason"] == "not negative"


def test_zero_quantity_needs_no_fix():
    result = decide_stock_reconciliation(0, 1, 0, True)
    assert result["needs_fix"] is False
    assert result["reason"] == "not negative"


def test_negative_but_not_stock_tracked_is_benign():
    result = decide_stock_reconciliation(-3, 0, 2, True)
    assert result["needs_fix"] is False
    assert result["new_quantity"] is None
    assert "benign" in result["reason"]


def test_negative_with_depends_on_stock_none_like_value_is_benign():
    # depends_on_stock=2 is not a real value in PrestaShop, but the function only
    # cares whether it is exactly 1, so anything else is treated as not tracked.
    result = decide_stock_reconciliation(-1, 2, 1, True)
    assert result["needs_fix"] is False


def test_negative_and_stock_tracked_needs_fix_dry_run():
    result = decide_stock_reconciliation(-1, 1, 1, True)
    assert result["needs_fix"] is True
    assert result["new_quantity"] is None
    assert result["reason"] == "negative tracked stock from oversell; clamp to zero"


def test_negative_and_stock_tracked_clamps_when_not_dry_run():
    result = decide_stock_reconciliation(-4, 1, 1, False)
    assert result["needs_fix"] is True
    assert result["new_quantity"] == 0
    assert result["reason"] == "negative tracked stock from oversell; clamp to zero"


def test_large_negative_still_flagged():
    result = decide_stock_reconciliation(-999, 1, 0, False)
    assert result["needs_fix"] is True
    assert result["new_quantity"] == 0
