from fix_link_rewrite import decide_slug_fix, is_link_rewrite, slugify


def test_valid_ascii_slug_is_left_alone():
    result = decide_slug_fix("blue-t-shirt", "Blue T-Shirt", False, ["red-t-shirt"])
    assert result == {"isValid": True, "proposedSlug": None, "reason": "ok"}


def test_full_url_is_rejected_with_slash_reason():
    result = decide_slug_fix("http://abc.com", "Blue T-Shirt", False, [])
    assert result["isValid"] is False
    assert result["reason"] == "contains slash"
    assert result["proposedSlug"] == "blue-t-shirt"


def test_bare_domain_like_value_is_rejected():
    result = decide_slug_fix("abc.com", "Blue T-Shirt", False, [])
    assert result["isValid"] is False
    assert result["proposedSlug"] == "blue-t-shirt"


def test_value_with_slash_is_rejected():
    result = decide_slug_fix("blue/shirt", "Blue Shirt", False, [])
    assert result["isValid"] is False
    assert result["reason"] == "contains slash"
    assert result["proposedSlug"] == "blue-shirt"


def test_value_with_space_is_rejected():
    result = decide_slug_fix("blue shirt", "Blue Shirt", False, [])
    assert result["isValid"] is False
    assert result["reason"] == "contains space"


def test_value_over_128_chars_is_rejected():
    long_slug = "a" * 129
    result = decide_slug_fix(long_slug, "Blue Shirt", False, [])
    assert result["isValid"] is False
    assert result["reason"] == "exceeds 128 chars"


def test_empty_value_is_rejected():
    result = decide_slug_fix("", "Blue Shirt", False, [])
    assert result["isValid"] is False
    assert result["reason"] == "empty or non-string value"
    assert result["proposedSlug"] == "blue-shirt"


def test_proposed_slug_gets_numeric_suffix_on_collision():
    result = decide_slug_fix("abc.com", "Blue Shirt", False, ["blue-shirt"])
    assert result["isValid"] is False
    assert result["proposedSlug"] == "blue-shirt-2"


def test_proposed_slug_keeps_incrementing_suffix_until_unique():
    result = decide_slug_fix("abc.com", "Blue Shirt", False, ["blue-shirt", "blue-shirt-2", "blue-shirt-3"])
    assert result["isValid"] is False
    assert result["proposedSlug"] == "blue-shirt-4"


def test_empty_after_normalization_falls_back_to_item():
    result = decide_slug_fix("http://", "!!!", False, [])
    assert result["isValid"] is False
    assert result["reason"] == "empty after normalization"
    assert result["proposedSlug"] == "item"


def test_accented_slug_rejected_in_ascii_mode_but_valid_when_allowed():
    ascii_result = decide_slug_fix("café-menu", "Café Menu", False, [])
    assert ascii_result["isValid"] is False

    accented_result = decide_slug_fix("café-menu", "Café Menu", True, [])
    assert accented_result == {"isValid": True, "proposedSlug": None, "reason": "ok"}


def test_is_link_rewrite_matches_prestashop_ascii_rule():
    assert is_link_rewrite("blue-t-shirt_2", False) is True
    assert is_link_rewrite("blue.shirt", False) is False
    assert is_link_rewrite("blue/shirt", False) is False
    assert is_link_rewrite("blue shirt", False) is False
    assert is_link_rewrite("", False) is False
    assert is_link_rewrite(None, False) is False


def test_slugify_lowercases_strips_and_collapses_hyphens():
    assert slugify("  Blue   T-Shirt!! ", False) == "blue-t-shirt"
    assert slugify("100% Cotton", False) == "100-cotton"
    assert slugify("", False) == ""


def test_slugify_transliterates_accents_when_not_allowed():
    assert slugify("Café Menu", False) == "cafe-menu"
