from find_broken_duplicates import classify_duplicate_integrity


def product(**over):
    base = {"id": 1, "reference": "SKU-1 (copy)", "name": "Widget (copy)", "active": True}
    base.update(over)
    return base


def combo(id_):
    return {"id": id_, "id_product_attribute": id_}


def stock(id_product_attribute):
    return {"id_product_attribute": id_product_attribute}


def test_ok_when_not_a_copy_and_nothing_missing():
    assert classify_duplicate_integrity(
        product(reference="SKU-1", name="Widget"), [combo(1)], [], [stock(1)]
    ) == "OK"


def test_missing_combinations_when_copy_has_none_but_sibling_did():
    result = classify_duplicate_integrity(product(), [], [], [], sibling_combination_count=3)
    assert result == "MISSING_COMBINATIONS"


def test_missing_features_when_copy_has_none_but_expected_some():
    result = classify_duplicate_integrity(
        product(expected_features=True), [], [], []
    )
    assert result == "MISSING_FEATURES"


def test_orphaned_stock_when_combination_lacks_matching_stock_row():
    result = classify_duplicate_integrity(
        product(), [combo(1), combo(2)], [], [stock(1)]
    )
    assert result == "ORPHANED_STOCK"


def test_suspect_partial_duplicate_when_fewer_combinations_than_sibling():
    result = classify_duplicate_integrity(
        product(), [combo(1)], [], [stock(1)], sibling_combination_count=3
    )
    assert result == "SUSPECT_PARTIAL_DUPLICATE"


def test_ok_when_copy_but_combination_count_matches_sibling():
    result = classify_duplicate_integrity(
        product(), [combo(1), combo(2)], [], [stock(1), stock(2)], sibling_combination_count=2
    )
    assert result == "OK"


def test_not_a_copy_is_never_flagged_even_with_fewer_combinations():
    result = classify_duplicate_integrity(
        product(reference="SKU-1", name="Widget"), [], [], [], sibling_combination_count=3
    )
    assert result == "OK"


def test_orphaned_stock_takes_priority_check_runs_before_partial_check():
    # combination 2 has no stock row -> ORPHANED_STOCK, even though the
    # combination count also happens to be lower than the sibling count.
    result = classify_duplicate_integrity(
        product(), [combo(1), combo(2)], [], [stock(1)], sibling_combination_count=5
    )
    assert result == "ORPHANED_STOCK"


def test_missing_combinations_requires_positive_sibling_count():
    # sibling_combination_count of 0 (or None) means we don't know the source
    # had any combinations, so an empty list is not flagged as missing.
    result = classify_duplicate_integrity(product(), [], [], [], sibling_combination_count=0)
    assert result == "OK"
