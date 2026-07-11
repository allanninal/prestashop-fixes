from find_reference_collisions import find_reference_collisions, find_combination_reference_collisions


def product(**over):
    base = {"id": 1, "reference": "SKU-123", "name": "Widget", "active": True}
    base.update(over)
    return base


def test_no_collision_when_references_are_unique():
    products = [product(id=1, reference="SKU-1"), product(id=2, reference="SKU-2")]
    assert find_reference_collisions(products) == {}


def test_finds_collision_for_same_reference_on_two_ids():
    products = [product(id=45, name="Red shirt"), product(id=812, name="Blue shirt")]
    result = find_reference_collisions(products)
    assert list(result.keys()) == ["SKU-123"]
    assert [p["id"] for p in result["SKU-123"]] == [45, 812]


def test_blank_reference_is_not_a_collision():
    products = [product(id=1, reference=""), product(id=2, reference="")]
    assert find_reference_collisions(products) == {}


def test_whitespace_only_reference_is_treated_as_blank():
    products = [product(id=1, reference="   "), product(id=2, reference="   ")]
    assert find_reference_collisions(products) == {}


def test_reference_is_normalized_by_trimming_before_grouping():
    products = [product(id=1, reference="SKU-123"), product(id=2, reference="  SKU-123  ")]
    result = find_reference_collisions(products)
    assert len(result["SKU-123"]) == 2


def test_single_product_with_a_reference_is_not_a_collision():
    products = [product(id=1, reference="SKU-1")]
    assert find_reference_collisions(products) == {}


def test_three_way_collision_keeps_all_ids_sorted():
    products = [product(id=30), product(id=5), product(id=17)]
    result = find_reference_collisions(products)
    assert [p["id"] for p in result["SKU-123"]] == [5, 17, 30]


def test_missing_reference_key_is_treated_as_blank():
    products = [{"id": 1, "name": "A", "active": True}, {"id": 2, "name": "B", "active": True}]
    assert find_reference_collisions(products) == {}


def test_combination_references_are_grouped_the_same_way():
    combinations = [
        {"id": 10, "id_product": 5, "reference": "VAR-9"},
        {"id": 11, "id_product": 6, "reference": "VAR-9"},
    ]
    result = find_combination_reference_collisions(combinations)
    assert list(result.keys()) == ["VAR-9"]
    assert [c["id"] for c in result["VAR-9"]] == [10, 11]


def test_combination_blank_reference_is_not_a_collision():
    combinations = [
        {"id": 10, "id_product": 5, "reference": ""},
        {"id": 11, "id_product": 6, "reference": ""},
    ]
    assert find_combination_reference_collisions(combinations) == {}
