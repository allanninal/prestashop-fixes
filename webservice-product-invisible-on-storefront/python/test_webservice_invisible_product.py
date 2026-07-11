from repair_invisible_product import decide_product_repair


def product(**over):
    base = {
        "active": 1,
        "visibility": "both",
        "id_category_default": 5,
        "associations": {"categories": [5], "shops": [1]},
    }
    base.update(over)
    return base


def context(**over):
    base = {"expectedShopIds": [1], "validCategoryIds": [2, 5]}
    base.update(over)
    return base


def test_ok_when_everything_is_wired_up():
    result = decide_product_repair(product(), context())
    assert result["status"] == "ok"
    assert result["patch"] is None


def test_ok_when_inactive_regardless_of_associations():
    p = product(active=0, associations={"categories": [], "shops": []})
    result = decide_product_repair(p, context())
    assert result["status"] == "ok"


def test_needs_repair_when_categories_empty():
    p = product(associations={"categories": [], "shops": [1]})
    result = decide_product_repair(p, context())
    assert result["status"] == "needs_repair"
    assert "categories" in result["missing"]
    assert result["patch"]["associations"]["categories"] == [5]


def test_needs_repair_when_default_category_not_in_categories():
    p = product(associations={"categories": [2], "shops": [1]})
    result = decide_product_repair(p, context())
    assert result["status"] == "needs_repair"
    assert "id_category_default_not_in_categories" in result["missing"]
    assert set(result["patch"]["associations"]["categories"]) == {2, 5}


def test_needs_repair_when_shops_empty():
    p = product(associations={"categories": [5], "shops": []})
    result = decide_product_repair(p, context())
    assert result["status"] == "needs_repair"
    assert "shops" in result["missing"]
    assert result["patch"]["associations"]["shops"] == [1]


def test_needs_repair_when_shops_missing_expected_id():
    p = product(associations={"categories": [5], "shops": [9]})
    result = decide_product_repair(p, context(expectedShopIds=[1, 2]))
    assert result["status"] == "needs_repair"
    assert "shops" in result["missing"]


def test_needs_repair_when_visibility_none():
    p = product(visibility="none")
    result = decide_product_repair(p, context())
    assert result["status"] == "needs_repair"
    assert "visibility" in result["missing"]
    assert result["patch"]["visibility"] == "both"


def test_unrepairable_when_default_category_invalid():
    p = product(id_category_default=999)
    result = decide_product_repair(p, context())
    assert result["status"] == "unrepairable"
    assert "default_category_invalid" in result["missing"]
    assert result["patch"] is None


def test_unrepairable_wins_even_with_other_missing_pieces():
    p = product(id_category_default=999, associations={"categories": [], "shops": []})
    result = decide_product_repair(p, context())
    assert result["status"] == "unrepairable"
    assert result["patch"] is None


def test_multiple_missing_pieces_combine_into_one_patch():
    p = product(visibility="none", associations={"categories": [], "shops": []})
    result = decide_product_repair(p, context())
    assert result["status"] == "needs_repair"
    assert set(result["missing"]) == {"categories", "shops", "visibility"}
    assert result["patch"]["associations"]["categories"] == [5]
    assert result["patch"]["associations"]["shops"] == [1]
    assert result["patch"]["visibility"] == "both"
