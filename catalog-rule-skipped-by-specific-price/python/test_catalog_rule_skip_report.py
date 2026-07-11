from catalog_rule_skip_report import classify_skipped_product

NOW = "2026-07-10 12:00:00"


def row(id_product, id_specific_price_rule, from_=None, to=None):
    return {
        "id_product": id_product,
        "id_specific_price_rule": id_specific_price_rule,
        "from": from_,
        "to": to,
    }


def test_not_targeted_is_not_skipped():
    result = classify_skipped_product({"id_product": 99}, {1, 2, 3}, [], NOW)
    assert result == {"skipped": False, "reason": None}


def test_manual_override_with_no_dates_blocks_rule():
    rows = [row(1, 0)]
    result = classify_skipped_product({"id_product": 1}, {1}, rows, NOW)
    assert result == {"skipped": True, "reason": "manual_specific_price_override_active"}


def test_manual_override_within_date_window_blocks_rule():
    rows = [row(1, 0, from_="2026-01-01 00:00:00", to="2026-12-31 23:59:59")]
    result = classify_skipped_product({"id_product": 1}, {1}, rows, NOW)
    assert result == {"skipped": True, "reason": "manual_specific_price_override_active"}


def test_manual_override_outside_date_window_does_not_block():
    rows = [row(1, 0, from_="2020-01-01 00:00:00", to="2020-12-31 23:59:59")]
    result = classify_skipped_product({"id_product": 1}, {1}, rows, NOW)
    assert result["skipped"] is False


def test_manual_override_starting_in_the_future_does_not_block():
    rows = [row(1, 0, from_="2027-01-01 00:00:00", to=None)]
    result = classify_skipped_product({"id_product": 1}, {1}, rows, NOW)
    assert result["skipped"] is False


def test_rule_applied_when_only_rule_row_exists():
    rows = [row(1, 42)]
    result = classify_skipped_product({"id_product": 1}, {1}, rows, NOW, id_rule=42)
    assert result == {"skipped": False, "reason": "rule_applied"}


def test_no_override_found_when_no_rows_at_all():
    result = classify_skipped_product({"id_product": 1}, {1}, [], NOW)
    assert result == {"skipped": False, "reason": "no_override_found"}


def test_manual_row_wins_even_when_rule_row_also_exists():
    rows = [row(1, 42), row(1, 0)]
    result = classify_skipped_product({"id_product": 1}, {1}, rows, NOW, id_rule=42)
    assert result == {"skipped": True, "reason": "manual_specific_price_override_active"}


def test_only_checks_rows_for_the_given_product():
    rows = [row(2, 0)]
    result = classify_skipped_product({"id_product": 1}, {1, 2}, rows, NOW)
    assert result == {"skipped": False, "reason": "no_override_found"}


def test_no_id_rule_given_and_only_a_rule_row_is_no_override_found():
    rows = [row(1, 42)]
    result = classify_skipped_product({"id_product": 1}, {1}, rows, NOW)
    assert result == {"skipped": False, "reason": "no_override_found"}
