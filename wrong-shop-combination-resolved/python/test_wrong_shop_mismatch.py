from find_shop_mismatch import find_shop_mismatched_combinations


def combo(**over):
    base = {"id_product_attribute": 100, "id_product": 10, "price": 19.99, "minimal_quantity": 1}
    base.update(over)
    return base


def test_flags_when_resolved_shop_not_in_actual_shops():
    result = find_shop_mismatched_combinations(1, [combo()], {100: {2, 3}})
    assert len(result) == 1
    assert result[0]["id_product_attribute"] == 100
    assert result[0]["resolved_in_shop"] == 1
    assert result[0]["actual_shops"] == [2, 3]


def test_no_flag_when_resolved_shop_is_among_actual_shops():
    result = find_shop_mismatched_combinations(1, [combo()], {100: {1, 2}})
    assert result == []


def test_no_flag_when_only_one_shop_and_it_matches():
    result = find_shop_mismatched_combinations(1, [combo()], {100: {1}})
    assert result == []


def test_flags_when_combination_has_no_association_at_all():
    result = find_shop_mismatched_combinations(1, [combo()], {})
    assert len(result) == 1
    assert result[0]["actual_shops"] == []


def test_multiple_combinations_only_mismatched_ones_flagged():
    combos = [combo(id_product_attribute=100), combo(id_product_attribute=200)]
    shop_map = {100: {1}, 200: {2}}
    result = find_shop_mismatched_combinations(1, combos, shop_map)
    assert len(result) == 1
    assert result[0]["id_product_attribute"] == 200


def test_reason_explains_missing_association():
    result = find_shop_mismatched_combinations(1, [combo()], {100: {2}})
    assert "product_attribute_shop" in result[0]["reason"]


def test_multiple_shops_for_one_combination_sorted():
    result = find_shop_mismatched_combinations(5, [combo()], {100: {3, 1, 2}})
    assert result[0]["actual_shops"] == [1, 2, 3]


def test_no_combinations_returns_empty_list():
    result = find_shop_mismatched_combinations(1, [], {100: {1}})
    assert result == []
