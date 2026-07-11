from combination_quantity_sum_mismatch import find_stock_mismatches

SHOP_ID = 1


def combo(id_):
    return {"id": id_, "id_product": 10}


def row(**over):
    base = {"id": 900, "id_product": 10, "id_product_attribute": 0, "id_shop": SHOP_ID, "quantity": 0}
    base.update(over)
    return base


def test_no_mismatch_when_sum_matches_product_row():
    combinations = [combo(1), combo(2)]
    rows = [
        row(id=900, id_product_attribute=0, quantity=7),
        row(id=901, id_product_attribute=1, quantity=3),
        row(id=902, id_product_attribute=2, quantity=4),
    ]
    result = find_stock_mismatches(10, combinations, rows, SHOP_ID)
    assert result["isMismatched"] is False
    assert result["combinationQuantitySum"] == 7
    assert result["delta"] == 0
    assert result["orphanedRowIds"] == []


def test_positive_delta_when_product_row_higher_than_sum():
    combinations = [combo(1)]
    rows = [
        row(id=900, id_product_attribute=0, quantity=10),
        row(id=901, id_product_attribute=1, quantity=4),
    ]
    result = find_stock_mismatches(10, combinations, rows, SHOP_ID)
    assert result["isMismatched"] is True
    assert result["delta"] == 6


def test_negative_delta_when_product_row_lower_than_sum():
    combinations = [combo(1)]
    rows = [
        row(id=900, id_product_attribute=0, quantity=2),
        row(id=901, id_product_attribute=1, quantity=9),
    ]
    result = find_stock_mismatches(10, combinations, rows, SHOP_ID)
    assert result["isMismatched"] is True
    assert result["delta"] == -7


def test_orphaned_row_reported_even_when_sum_matches():
    # id_product_attribute 5 no longer exists in the live combinations list,
    # but it happens to make the naive sum equal the product row anyway.
    combinations = [combo(1)]
    rows = [
        row(id=900, id_product_attribute=0, quantity=4),
        row(id=901, id_product_attribute=1, quantity=4),
        row(id=902, id_product_attribute=5, quantity=99),
    ]
    result = find_stock_mismatches(10, combinations, rows, SHOP_ID)
    assert result["orphanedRowIds"] == [902]
    assert result["combinationQuantitySum"] == 4
    assert result["isMismatched"] is False


def test_zero_combinations_is_never_flagged():
    rows = [row(id=900, id_product_attribute=0, quantity=123)]
    result = find_stock_mismatches(10, [], rows, SHOP_ID)
    assert result["isMismatched"] is False
    assert result["productLevelQuantity"] == 123


def test_rows_scoped_to_requested_shop_only():
    combinations = [combo(1)]
    rows = [
        row(id=900, id_product_attribute=0, id_shop=2, quantity=999),
        row(id=901, id_product_attribute=1, id_shop=1, quantity=5),
    ]
    result = find_stock_mismatches(10, combinations, rows, SHOP_ID)
    assert result["productLevelQuantity"] is None
    assert result["combinationQuantitySum"] == 5


def test_missing_product_row_defaults_to_none_quantity():
    combinations = [combo(1)]
    rows = [row(id=901, id_product_attribute=1, quantity=5)]
    result = find_stock_mismatches(10, combinations, rows, SHOP_ID)
    assert result["productLevelQuantity"] is None
    assert result["delta"] == -5
    assert result["isMismatched"] is True
