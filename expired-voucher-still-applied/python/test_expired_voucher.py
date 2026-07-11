from check_expired_voucher import is_voucher_expired_for_record

DATE_FROM = 1751328000.0  # 2025-07-01T00:00:00Z
DATE_TO = 1751932800.0    # 2025-07-08T00:00:00Z


def test_valid_within_window_is_not_flagged():
    record_date = DATE_FROM + 3600
    assert is_voucher_expired_for_record(record_date, DATE_FROM, DATE_TO, True) is False


def test_exactly_at_date_to_is_not_flagged():
    assert is_voucher_expired_for_record(DATE_TO, DATE_FROM, DATE_TO, True) is False


def test_one_second_past_date_to_is_flagged():
    assert is_voucher_expired_for_record(DATE_TO + 1, DATE_FROM, DATE_TO, True) is True


def test_before_date_from_is_flagged():
    assert is_voucher_expired_for_record(DATE_FROM - 1, DATE_FROM, DATE_TO, True) is True


def test_inactive_rule_still_referenced_is_flagged():
    record_date = DATE_FROM + 3600
    assert is_voucher_expired_for_record(record_date, DATE_FROM, DATE_TO, False) is True


def test_inactive_and_expired_is_still_just_flagged_true():
    assert is_voucher_expired_for_record(DATE_TO + 10, DATE_FROM, DATE_TO, False) is True


def test_exactly_at_date_from_is_not_flagged():
    assert is_voucher_expired_for_record(DATE_FROM, DATE_FROM, DATE_TO, True) is False
