from diagnose_multistore_default_combination import classify_default_combination_state


def combo(**over):
    base = {"id": 1, "id_product_attribute": 10, "default_on": "0"}
    base.update(over)
    return base


def test_not_applicable_when_no_combinations():
    assert classify_default_combination_state([], None, True) == "NOT_APPLICABLE"


def test_ok_when_exactly_one_default_matches_pointer():
    combos = [combo(id_product_attribute=10, default_on="1"), combo(id_product_attribute=11, default_on="0")]
    assert classify_default_combination_state(combos, 10, True) == "OK"


def test_duplicate_default_when_two_rows_flagged():
    combos = [combo(id_product_attribute=10, default_on="1"), combo(id_product_attribute=11, default_on="1")]
    assert classify_default_combination_state(combos, 10, True) == "DUPLICATE_DEFAULT"


def test_missing_default_on_active_shop():
    combos = [combo(id_product_attribute=10, default_on="0"), combo(id_product_attribute=11, default_on="0")]
    assert classify_default_combination_state(combos, None, True) == "MISSING_DEFAULT"


def test_missing_default_ignored_on_inactive_shop():
    combos = [combo(id_product_attribute=10, default_on="0")]
    assert classify_default_combination_state(combos, None, False) == "NOT_APPLICABLE"


def test_pointer_mismatch_when_product_points_elsewhere():
    combos = [combo(id_product_attribute=10, default_on="1")]
    assert classify_default_combination_state(combos, 99, True) == "POINTER_MISMATCH"


def test_ok_when_pointer_is_none_and_one_default_exists():
    combos = [combo(id_product_attribute=10, default_on="1")]
    assert classify_default_combination_state(combos, None, True) == "OK"


def test_duplicate_wins_over_pointer_mismatch():
    # Even if neither flagged row matches the pointer, duplicates are reported first.
    combos = [combo(id_product_attribute=10, default_on="1"), combo(id_product_attribute=11, default_on="1")]
    assert classify_default_combination_state(combos, 999, True) == "DUPLICATE_DEFAULT"


def test_not_applicable_ignores_pointer_when_shop_inactive_and_no_default():
    combos = [combo(id_product_attribute=10, default_on="0"), combo(id_product_attribute=11, default_on="0")]
    assert classify_default_combination_state(combos, 10, False) == "NOT_APPLICABLE"
