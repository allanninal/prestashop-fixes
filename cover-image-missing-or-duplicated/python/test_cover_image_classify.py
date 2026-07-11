from fix_cover_image import classify_cover_state


def test_no_images_means_no_images_status():
    result = classify_cover_state([])
    assert result == {"status": "no_images", "coverIds": [], "chosenCoverId": None}


def test_ok_when_exactly_one_cover():
    images = [
        {"id_image": 1, "cover": "1", "position": 0},
        {"id_image": 2, "cover": "0", "position": 1},
    ]
    result = classify_cover_state(images)
    assert result == {"status": "ok", "coverIds": [1], "chosenCoverId": 1}


def test_no_cover_picks_lowest_position():
    images = [
        {"id_image": 5, "cover": "0", "position": 2},
        {"id_image": 3, "cover": "0", "position": 0},
        {"id_image": 4, "cover": "0", "position": 1},
    ]
    result = classify_cover_state(images)
    assert result["status"] == "no_cover"
    assert result["coverIds"] == []
    assert result["chosenCoverId"] == 3


def test_no_cover_breaks_position_tie_by_lowest_id():
    images = [
        {"id_image": 9, "cover": "0", "position": 0},
        {"id_image": 2, "cover": "0", "position": 0},
    ]
    result = classify_cover_state(images)
    assert result["status"] == "no_cover"
    assert result["chosenCoverId"] == 2


def test_multi_cover_flags_all_cover_ids_and_chooses_lowest_position():
    images = [
        {"id_image": 1, "cover": "1", "position": 3},
        {"id_image": 2, "cover": "1", "position": 0},
        {"id_image": 3, "cover": "0", "position": 1},
    ]
    result = classify_cover_state(images)
    assert result["status"] == "multi_cover"
    assert sorted(result["coverIds"]) == [1, 2]
    assert result["chosenCoverId"] == 2


def test_multi_cover_breaks_position_tie_by_lowest_id():
    images = [
        {"id_image": 7, "cover": "1", "position": 0},
        {"id_image": 4, "cover": "1", "position": 0},
    ]
    result = classify_cover_state(images)
    assert result["status"] == "multi_cover"
    assert result["chosenCoverId"] == 4


def test_boolean_true_is_treated_as_cover():
    images = [
        {"id_image": 1, "cover": True, "position": 0},
        {"id_image": 2, "cover": False, "position": 1},
    ]
    result = classify_cover_state(images)
    assert result == {"status": "ok", "coverIds": [1], "chosenCoverId": 1}


def test_three_covers_flags_all_and_chooses_lowest_position():
    images = [
        {"id_image": 1, "cover": "1", "position": 5},
        {"id_image": 2, "cover": "1", "position": 2},
        {"id_image": 3, "cover": "1", "position": 8},
    ]
    result = classify_cover_state(images)
    assert result["status"] == "multi_cover"
    assert sorted(result["coverIds"]) == [1, 2, 3]
    assert result["chosenCoverId"] == 2
