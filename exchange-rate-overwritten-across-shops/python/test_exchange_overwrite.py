from detect_rate_overwrite import detect_rate_overwrite


def test_flags_when_two_disagreeing_shops_collapse_to_one_rate():
    previous = {(1, 3): 0.92, (2, 3): 0.95}
    current = {(1, 3): 0.90, (2, 3): 0.90}
    findings = detect_rate_overwrite(previous, current)
    assert len(findings) == 1
    assert findings[0]["id_currency"] == 3
    assert findings[0]["id_shops_collapsed"] == [1, 2]
    assert findings[0]["new_rate"] == 0.90


def test_no_flag_when_shops_already_agreed():
    previous = {(1, 3): 0.90, (2, 3): 0.90}
    current = {(1, 3): 0.90, (2, 3): 0.90}
    assert detect_rate_overwrite(previous, current) == []


def test_no_flag_when_only_one_shop_changed():
    previous = {(1, 3): 0.92, (2, 3): 0.95}
    current = {(1, 3): 0.90, (2, 3): 0.95}
    assert detect_rate_overwrite(previous, current) == []


def test_no_flag_with_no_previous_snapshot():
    current = {(1, 3): 0.90, (2, 3): 0.90}
    assert detect_rate_overwrite({}, current) == []


def test_identifies_likely_source_shop_when_unambiguous():
    previous = {(1, 3): 0.92, (2, 3): 0.95, (3, 3): 0.90}
    current = {(1, 3): 0.90, (2, 3): 0.90, (3, 3): 0.90}
    findings = detect_rate_overwrite(previous, current)
    assert findings[0]["likely_source_shop"] == 3


def test_tolerance_absorbs_tiny_float_noise():
    previous = {(1, 3): 0.92, (2, 3): 0.95}
    current = {(1, 3): 0.9000001, (2, 3): 0.9000002}
    findings = detect_rate_overwrite(previous, current, tolerance=1e-4)
    assert len(findings) == 1
    assert findings[0]["new_rate"] == 0.9000001


def test_multiple_currencies_are_evaluated_independently():
    previous = {(1, 3): 0.92, (2, 3): 0.95, (1, 4): 1.10, (2, 4): 1.10}
    current = {(1, 3): 0.90, (2, 3): 0.90, (1, 4): 1.10, (2, 4): 1.10}
    findings = detect_rate_overwrite(previous, current)
    assert len(findings) == 1
    assert findings[0]["id_currency"] == 3


def test_no_flag_when_three_shops_all_disagreed_and_all_still_disagree():
    previous = {(1, 3): 0.90, (2, 3): 0.92, (3, 3): 0.95}
    current = {(1, 3): 0.90, (2, 3): 0.92, (3, 3): 0.95}
    assert detect_rate_overwrite(previous, current) == []


def test_no_likely_source_when_no_shop_matches_new_rate_exactly():
    previous = {(1, 3): 0.92, (2, 3): 0.95}
    current = {(1, 3): 0.90, (2, 3): 0.90}
    findings = detect_rate_overwrite(previous, current)
    assert findings[0]["likely_source_shop"] is None
