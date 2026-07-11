from orphaned_stock_rows import find_orphan_stock_rows


def combo(id_):
    return {"id": id_}


def row(**over):
    base = {"id": 1, "id_product_attribute": 5, "quantity": 0, "out_of_stock": 2}
    base.update(over)
    return base


def test_no_orphans_when_every_row_matches_a_live_combination():
    combinations = [combo(5), combo(6)]
    stock_rows = [row(id_product_attribute=5), row(id=2, id_product_attribute=6)]
    assert find_orphan_stock_rows(combinations, stock_rows) == []


def test_base_product_row_with_zero_attribute_is_never_an_orphan():
    stock_rows = [row(id=1, id_product_attribute=0)]
    assert find_orphan_stock_rows([], stock_rows) == []


def test_empty_combinations_list_only_keeps_the_zero_row():
    stock_rows = [row(id=1, id_product_attribute=0), row(id=2, id_product_attribute=7, quantity=4)]
    result = find_orphan_stock_rows([], stock_rows)
    assert result == [row(id=2, id_product_attribute=7, quantity=4)]


def test_stock_row_for_deleted_combination_is_an_orphan():
    combinations = [combo(5)]
    stock_rows = [row(id=1, id_product_attribute=5), row(id=2, id_product_attribute=9, quantity=3)]
    result = find_orphan_stock_rows(combinations, stock_rows)
    assert result == [row(id=2, id_product_attribute=9, quantity=3)]


def test_duplicate_stock_rows_for_the_same_orphaned_attribute_are_all_returned():
    stock_rows = [
        row(id=2, id_product_attribute=9, quantity=3),
        row(id=3, id_product_attribute=9, quantity=2),
    ]
    result = find_orphan_stock_rows([], stock_rows)
    assert result == stock_rows


def test_combination_present_but_stock_row_missing_is_not_flagged_as_orphan():
    # A live combination with no matching stock row is a different problem,
    # not something find_orphan_stock_rows reports on.
    combinations = [combo(5), combo(6)]
    stock_rows = [row(id=1, id_product_attribute=5)]
    assert find_orphan_stock_rows(combinations, stock_rows) == []


def test_orphan_quantity_sum_reflects_inflated_displayed_total():
    combinations = [combo(5)]
    stock_rows = [
        row(id=1, id_product_attribute=5, quantity=10),
        row(id=2, id_product_attribute=9, quantity=3),
        row(id=3, id_product_attribute=12, quantity=7),
    ]
    orphans = find_orphan_stock_rows(combinations, stock_rows)
    assert sum(o["quantity"] for o in orphans) == 10
