from fix_default_category import choose_valid_default_category


def test_no_action_when_default_is_already_valid():
    result = choose_valid_default_category(10, 5, [5, 6], {5, 6, 2})
    assert result == {"id_product": 10, "action": "none", "new_default": 5}


def test_reassigns_to_deepest_remaining_valid_category():
    result = choose_valid_default_category(11, 99, [3, 7], {2, 3, 7})
    assert result["action"] == "reassign"
    assert result["old_default"] == 99
    assert result["new_default"] == 7


def test_falls_back_to_root_when_no_valid_categories_left():
    result = choose_valid_default_category(12, 99, [], {2, 3, 7})
    assert result == {"id_product": 12, "action": "reassign", "old_default": 99, "new_default": 2}


def test_flags_manual_when_even_fallback_root_is_missing():
    result = choose_valid_default_category(13, 99, [], {3, 7}, fallback_root_id=2)
    assert result == {"id_product": 13, "action": "flag_manual", "old_default": 99, "new_default": None}


def test_ignores_associated_categories_that_are_also_invalid():
    result = choose_valid_default_category(14, 99, [98, 97], {2, 3}, fallback_root_id=2)
    assert result["action"] == "reassign"
    assert result["new_default"] == 2


def test_excludes_current_default_from_candidates_even_if_technically_valid():
    # associated_category_ids should never resurrect the same broken id even if
    # it happens to still be listed among the product's own categories
    result = choose_valid_default_category(15, 99, [99, 6], {6, 2})
    assert result["new_default"] == 6


def test_zero_default_with_no_categories_falls_back_to_root():
    result = choose_valid_default_category(16, 0, [], {2, 9})
    assert result == {"id_product": 16, "action": "reassign", "old_default": 0, "new_default": 2}


def test_picks_max_id_among_multiple_valid_candidates():
    result = choose_valid_default_category(17, 50, [4, 12, 8], {2, 4, 8, 12})
    assert result["new_default"] == 12
