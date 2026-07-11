from flag_default_category_drift import find_default_category_drift, assigned_category_ids


def test_flags_when_default_not_in_assigned_ids():
    drift = find_default_category_drift(9, [1, 2, 3])
    assert drift == {"id_category_default": 9, "valid_category_ids": [1, 2, 3]}


def test_no_flag_when_default_is_assigned():
    assert find_default_category_drift(2, [1, 2, 3]) is None


def test_no_flag_when_default_is_none():
    assert find_default_category_drift(None, [1, 2, 3]) is None


def test_flags_with_empty_valid_category_ids_when_assigned_list_is_empty():
    drift = find_default_category_drift(5, [])
    assert drift == {"id_category_default": 5, "valid_category_ids": []}


def test_valid_category_ids_are_sorted_and_deduplicated():
    drift = find_default_category_drift(9, [3, 1, 2, 1, 3])
    assert drift == {"id_category_default": 9, "valid_category_ids": [1, 2, 3]}


def test_accepts_string_ids_from_the_webservice():
    assert find_default_category_drift("2", ["1", "2", "3"]) is None
    drift = find_default_category_drift("9", ["1", "2", "3"])
    assert drift == {"id_category_default": 9, "valid_category_ids": [1, 2, 3]}


def test_assigned_category_ids_reads_the_webservice_shape():
    product = {"associations": {"categories": {"category": [{"id": "1"}, {"id": "2"}]}}}
    assert assigned_category_ids(product) == [1, 2]


def test_assigned_category_ids_handles_missing_associations():
    assert assigned_category_ids({}) == []
