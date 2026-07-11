from datetime import date
from report_orphaned_vouchers import is_orphaned_codeless_voucher

TODAY = date(2026, 7, 10)


def test_exhausted_codeless_rule_is_orphaned():
    assert is_orphaned_codeless_voucher("", 0, "2026-12-31", True, TODAY) is True


def test_expired_codeless_rule_is_orphaned():
    assert is_orphaned_codeless_voucher("", 5, "2026-01-01", True, TODAY) is True


def test_disabled_codeless_rule_is_orphaned():
    assert is_orphaned_codeless_voucher("", 5, "2026-12-31", False, TODAY) is True


def test_still_valid_codeless_rule_is_not_orphaned():
    assert is_orphaned_codeless_voucher("", 5, "2026-12-31", True, TODAY) is False


def test_rule_with_code_is_never_orphaned_even_if_exhausted():
    assert is_orphaned_codeless_voucher("SUMMER10", 0, "2026-01-01", False, TODAY) is False


def test_blank_date_to_with_remaining_quantity_is_not_orphaned():
    assert is_orphaned_codeless_voucher("", 3, None, True, TODAY) is False


def test_whitespace_only_code_counts_as_codeless():
    assert is_orphaned_codeless_voucher("   ", 0, "2026-12-31", True, TODAY) is True


def test_expired_but_has_code_is_not_orphaned():
    assert is_orphaned_codeless_voucher("VIP5", 0, "2020-01-01", False, TODAY) is False


def test_quantity_exactly_zero_is_exhausted():
    assert is_orphaned_codeless_voucher("", 0, None, True, TODAY) is True


def test_date_to_equal_today_is_not_expired():
    assert is_orphaned_codeless_voucher("", 5, "2026-07-10", True, TODAY) is False
