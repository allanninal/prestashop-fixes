from audit_multistore_tax_rate import compute_expected_tax, select_applicable_tax_rate


def test_compute_expected_tax_basic():
    assert compute_expected_tax(100.0, 2, 20.0) == 240.0


def test_compute_expected_tax_rounds_to_cents():
    assert compute_expected_tax(19.99, 3, 7.7) == round(19.99 * 3 * 1.077, 2)


def test_compute_expected_tax_zero_rate():
    assert compute_expected_tax(50.0, 1, 0.0) == 50.0


def test_selects_rule_matching_order_country():
    rules = [{"id_country": 1, "rate": 20.0}, {"id_country": 8, "rate": 7.7}]
    assert select_applicable_tax_rate(8, 1, rules) == 7.7


def test_does_not_fall_back_to_shop_default_country_when_order_country_matches():
    # order country is 8, shop default country is 1; both have rules, but the
    # customer's own country must win, not the shop's.
    rules = [{"id_country": 1, "rate": 20.0}, {"id_country": 8, "rate": 7.7}]
    assert select_applicable_tax_rate(8, 1, rules) != 20.0


def test_falls_back_to_shop_default_country_only_when_no_order_country_rule():
    rules = [{"id_country": 1, "rate": 20.0}]
    assert select_applicable_tax_rate(8, 1, rules) == 20.0


def test_returns_zero_when_no_rule_matches_either_country():
    rules = [{"id_country": 99, "rate": 15.0}]
    assert select_applicable_tax_rate(8, 1, rules) == 0.0


def test_order_country_equal_to_shop_default_country_still_matches():
    rules = [{"id_country": 1, "rate": 20.0}]
    assert select_applicable_tax_rate(1, 1, rules) == 20.0
