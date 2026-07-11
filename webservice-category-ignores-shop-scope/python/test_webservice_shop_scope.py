from flag_category_shop_scope import is_over_associated, unintended_shop_ids, resolved_shop_ids


def test_flags_when_associated_with_every_shop_but_one_expected():
    category = {"id": 10, "id_shop_default": 1, "associations": {"shops": [{"id": 1}, {"id": 2}, {"id": 3}]}}
    assert is_over_associated(category, {1}, {1, 2, 3}) is True


def test_no_flag_when_associated_matches_expected_exactly():
    category = {"id": 11, "id_shop_default": 1, "associations": {"shops": [{"id": 1}]}}
    assert is_over_associated(category, {1}, {1, 2, 3}) is False


def test_no_flag_when_expected_covers_all_shops():
    category = {"id": 12, "id_shop_default": 1, "associations": {"shops": [{"id": 1}, {"id": 2}, {"id": 3}]}}
    assert is_over_associated(category, {1, 2, 3}, {1, 2, 3}) is False


def test_falls_back_to_id_shop_default_when_no_associations_node():
    category = {"id": 13, "id_shop_default": 2}
    assert resolved_shop_ids(category) == {2}
    assert is_over_associated(category, {1}, {1, 2, 3}) is True


def test_no_flag_when_no_shop_signal_at_all():
    category = {"id": 14}
    assert is_over_associated(category, {1}, {1, 2, 3}) is False


def test_unintended_shop_ids_reports_the_diff():
    category = {"id": 15, "id_shop_default": 1, "associations": {"shops": [{"id": 1}, {"id": 2}, {"id": 3}]}}
    assert unintended_shop_ids(category, {1}) == {2, 3}


def test_two_expected_shops_narrower_than_all_is_flagged():
    category = {"id": 16, "id_shop_default": 1, "associations": {"shops": [{"id": 1}, {"id": 2}, {"id": 3}]}}
    assert is_over_associated(category, {1, 2}, {1, 2, 3}) is True


def test_empty_associations_list_falls_back_to_default():
    category = {"id": 17, "id_shop_default": 1, "associations": {"shops": []}}
    assert resolved_shop_ids(category) == {1}


def test_not_over_associated_when_subset_of_expected():
    category = {"id": 18, "id_shop_default": 1, "associations": {"shops": [{"id": 1}]}}
    assert is_over_associated(category, {1, 2, 3}, {1, 2, 3}) is False
