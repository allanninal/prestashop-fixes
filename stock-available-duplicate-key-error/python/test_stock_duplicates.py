from find_duplicate_stock import find_duplicate_stock_rows, find_orphaned_combination_rows


def row(**over):
    base = {"id": 1, "id_product": 10, "id_product_attribute": 0, "id_shop": 1, "id_shop_group": 1, "quantity": 5}
    base.update(over)
    return base


def test_no_duplicates_when_all_keys_unique():
    rows = [row(id=1), row(id=2, id_product_attribute=2)]
    assert find_duplicate_stock_rows(rows) == []


def test_finds_duplicate_group_for_same_natural_key():
    rows = [row(id=1, quantity=5), row(id=2, quantity=8)]
    groups = find_duplicate_stock_rows(rows)
    assert len(groups) == 1
    assert len(groups[0]) == 2


def test_keep_candidate_is_highest_id_within_a_group():
    rows = [row(id=1, id_shop=0, id_shop_group=0), row(id=2, id_shop=0, id_shop_group=0)]
    groups = find_duplicate_stock_rows(rows)
    assert groups[0][0]["id"] == 2  # highest id wins, both rows share the same shop scope


def test_rows_with_different_shop_scope_are_not_grouped_together():
    rows = [row(id=9, id_shop=0, id_shop_group=0), row(id=2, id_shop=1, id_shop_group=1)]
    assert find_duplicate_stock_rows(rows) == []  # different id_shop means a different natural key


def test_three_way_duplicate_group_keeps_highest_id():
    rows = [row(id=1), row(id=2), row(id=3)]
    groups = find_duplicate_stock_rows(rows)
    assert len(groups) == 1
    assert len(groups[0]) == 3
    assert groups[0][0]["id"] == 3


def test_orphaned_rows_flagged_when_combination_missing():
    rows = [row(id=1, id_product_attribute=99)]
    assert find_orphaned_combination_rows(rows, {1, 2}) == rows


def test_no_orphan_for_simple_product_row():
    rows = [row(id=1, id_product_attribute=0)]
    assert find_orphaned_combination_rows(rows, {1, 2}) == []


def test_no_orphan_when_combination_still_live():
    rows = [row(id=1, id_product_attribute=2)]
    assert find_orphaned_combination_rows(rows, {1, 2}) == []
