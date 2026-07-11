from check_stock_invariant import checkStockInvariant


def stock_row(**over):
    base = {"quantity": 7, "physicalQuantity": 10, "reservedQuantity": 3}
    base.update(over)
    return base


def test_in_sync_when_formula_and_reserved_match():
    result = checkStockInvariant(stock_row(), 3)
    assert result["inSync"] is True
    assert result["formulaViolation"] is False
    assert result["reservedMismatch"] is False
    assert result["expectedQuantity"] == 7


def test_formula_violation_when_physical_not_equal_quantity_plus_reserved():
    row = stock_row(quantity=7, physicalQuantity=10, reservedQuantity=1)
    result = checkStockInvariant(row, 1)
    assert result["formulaViolation"] is True
    assert result["reservedMismatch"] is False
    assert result["inSync"] is False
    assert result["expectedQuantity"] == 9


def test_reserved_mismatch_when_computed_differs_from_stored():
    row = stock_row(quantity=7, physicalQuantity=10, reservedQuantity=3)
    result = checkStockInvariant(row, 5)
    assert result["reservedMismatch"] is True
    assert result["formulaViolation"] is False
    assert result["inSync"] is False
    assert result["expectedQuantity"] == 5


def test_both_violations_can_be_true_at_once():
    row = stock_row(quantity=7, physicalQuantity=10, reservedQuantity=1)
    result = checkStockInvariant(row, 5)
    assert result["formulaViolation"] is True
    assert result["reservedMismatch"] is True
    assert result["inSync"] is False
    assert result["expectedQuantity"] == 5


def test_out_of_stock_forced_negative_quantity_is_flagged():
    # Documented core bug: quantity forced to -1 while reserved_quantity goes to 1.
    row = stock_row(quantity=-1, physicalQuantity=0, reservedQuantity=1)
    result = checkStockInvariant(row, 0)
    assert result["formulaViolation"] is False
    assert result["reservedMismatch"] is True
    assert result["inSync"] is False
    assert result["expectedQuantity"] == 0


def test_zero_reserved_after_multistore_share_stock_reset():
    row = stock_row(quantity=10, physicalQuantity=10, reservedQuantity=0)
    result = checkStockInvariant(row, 4)
    assert result["reservedMismatch"] is True
    assert result["expectedQuantity"] == 6
    assert result["inSync"] is False
