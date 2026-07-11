from orphaned_combination_shops import find_orphaned_combination_shops


def row(**over):
    base = {"id_product_attribute": 10, "id_shop": 1}
    base.update(over)
    return base


def test_no_orphans_when_every_row_matches_product_and_active_shops():
    product_shop_ids = {1, 2}
    active_shop_ids = {1, 2}
    rows = [row(id_shop=1), row(id_shop=2, id_product_attribute=11)]
    assert find_orphaned_combination_shops(product_shop_ids, active_shop_ids, rows) == []


def test_shop_unassigned_from_product_is_orphaned():
    product_shop_ids = {1}
    active_shop_ids = {1, 2}
    rows = [row(id_shop=2)]
    result = find_orphaned_combination_shops(product_shop_ids, active_shop_ids, rows)
    assert result == [{"id_product_attribute": 10, "id_shop": 2, "reason": "shop_unassigned_from_product"}]


def test_inactive_shop_is_orphaned_even_if_product_still_lists_it():
    product_shop_ids = {1, 3}
    active_shop_ids = {1}
    rows = [row(id_shop=3)]
    result = find_orphaned_combination_shops(product_shop_ids, active_shop_ids, rows)
    assert result == [{"id_product_attribute": 10, "id_shop": 3, "reason": "shop_inactive"}]


def test_inactive_shop_reason_wins_over_unassigned_reason():
    # A shop that is both unassigned from the product and globally inactive
    # is reported once, tagged shop_inactive, since that is the stronger reason.
    product_shop_ids = set()
    active_shop_ids = set()
    rows = [row(id_shop=9)]
    result = find_orphaned_combination_shops(product_shop_ids, active_shop_ids, rows)
    assert result == [{"id_product_attribute": 10, "id_shop": 9, "reason": "shop_inactive"}]


def test_empty_rows_returns_empty_list():
    assert find_orphaned_combination_shops({1}, {1}, []) == []


def test_multiple_combinations_each_orphaned_independently():
    product_shop_ids = {1}
    active_shop_ids = {1, 2}
    rows = [row(id_product_attribute=10, id_shop=2), row(id_product_attribute=11, id_shop=2)]
    result = find_orphaned_combination_shops(product_shop_ids, active_shop_ids, rows)
    assert result == [
        {"id_product_attribute": 10, "id_shop": 2, "reason": "shop_unassigned_from_product"},
        {"id_product_attribute": 11, "id_shop": 2, "reason": "shop_unassigned_from_product"},
    ]
