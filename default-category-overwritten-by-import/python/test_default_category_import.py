from reconcile_import_default_category import decide_category_repair


def test_unchanged_default_is_none():
    result = decide_category_repair(1, None, 5, 5, [1, 5, 9])
    assert result["action"] == "none"
    assert result["restore_to"] is None


def test_reset_to_home_is_repair():
    result = decide_category_repair(1, None, 9, 2, [1, 2, 9])
    assert result["action"] == "repair"
    assert result["restore_to"] == 9


def test_dropped_association_is_flag_not_repair():
    result = decide_category_repair(1, None, 9, 2, [1, 2])
    assert result["action"] == "flag"
    assert result["restore_to"] is None


def test_ambiguous_shift_is_flag_with_restore_hint():
    result = decide_category_repair(1, None, 9, 12, [1, 9, 12])
    assert result["action"] == "flag"
    assert result["restore_to"] == 9


def test_already_home_moving_to_another_category_is_flag():
    # pre_import_default == root_category_id, so the "reset to Home" branch
    # cannot apply even though post_default changed.
    result = decide_category_repair(1, None, 2, 12, [1, 2, 12])
    assert result["action"] == "flag"
    assert result["restore_to"] == 2


def test_multistore_pair_is_carried_through_untouched():
    result = decide_category_repair(7, 3, 9, 2, [1, 2, 9])
    assert result["product_id"] == 7
    assert result["id_shop"] == 3
    assert result["action"] == "repair"


def test_custom_root_category_id_is_respected():
    result = decide_category_repair(1, None, 9, 20, [1, 9, 20], root_category_id=20)
    assert result["action"] == "repair"
    assert result["restore_to"] == 9


def test_string_ids_from_the_webservice_are_coerced():
    result = decide_category_repair(1, None, "9", "2", ["1", "2", "9"])
    assert result["action"] == "repair"
    assert result["restore_to"] == 9


def test_flag_when_default_changes_but_stays_off_root_and_not_in_associations():
    result = decide_category_repair(1, None, 9, 12, [1, 12])
    assert result["action"] == "flag"
    assert result["restore_to"] is None
