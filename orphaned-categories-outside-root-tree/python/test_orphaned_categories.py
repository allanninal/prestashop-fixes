from find_orphaned_categories import find_orphans


def cat(id, id_parent):
    return {"id": id, "id_parent": id_parent, "is_root_category": False}


def test_reachable_tree_has_no_orphans():
    categories = [cat(2, 1), cat(3, 1), cat(4, 2)]
    result = find_orphans(categories, {1}, [])
    assert result["orphaned_categories"] == []


def test_category_pointing_at_deleted_parent_is_orphaned():
    # id_parent 99 does not exist anywhere in the categories list
    categories = [cat(2, 1), cat(3, 99)]
    result = find_orphans(categories, {1}, [])
    assert result["orphaned_categories"] == [3]


def test_whole_orphaned_branch_is_flagged():
    categories = [cat(2, 1), cat(3, 99), cat(4, 3)]
    result = find_orphans(categories, {1}, [])
    assert result["orphaned_categories"] == [3, 4]


def test_root_ids_are_never_flagged():
    categories = [cat(2, 1)]
    result = find_orphans(categories, {1, 2}, [])
    assert result["orphaned_categories"] == []


def test_cycle_outside_root_is_orphaned():
    # 3 and 4 point at each other, neither one chains back to root 1
    categories = [cat(2, 1), cat(3, 4), cat(4, 3)]
    result = find_orphans(categories, {1}, [])
    assert sorted(result["orphaned_categories"]) == [3, 4]


def test_product_with_only_orphaned_category_is_flagged():
    categories = [cat(2, 1), cat(3, 99)]
    products = [{"id": 501, "id_category_default": 3, "category_ids": [3]}]
    result = find_orphans(categories, {1}, products)
    assert result["orphaned_products"] == [501]


def test_product_reachable_through_any_category_is_not_flagged():
    categories = [cat(2, 1), cat(3, 99)]
    products = [{"id": 502, "id_category_default": 3, "category_ids": [3, 2]}]
    result = find_orphans(categories, {1}, products)
    assert result["orphaned_products"] == []


def test_product_with_no_category_signal_at_all_is_flagged():
    categories = [cat(2, 1)]
    products = [{"id": 503, "id_category_default": None, "category_ids": []}]
    result = find_orphans(categories, {1}, products)
    assert result["orphaned_products"] == [503]


def test_product_reachable_through_default_category_is_not_flagged():
    categories = [cat(2, 1)]
    products = [{"id": 504, "id_category_default": 2, "category_ids": []}]
    result = find_orphans(categories, {1}, products)
    assert result["orphaned_products"] == []


def test_multiple_shop_roots_are_all_respected():
    # Two shops, two separate roots (10 and 20), each with their own branch
    categories = [cat(11, 10), cat(21, 20), cat(31, 99)]
    result = find_orphans(categories, {10, 20}, [])
    assert result["orphaned_categories"] == [31]
