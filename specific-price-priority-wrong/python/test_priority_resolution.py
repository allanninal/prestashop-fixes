from check_specific_price_priority import resolve_best_specific_price, find_price_mismatch

BASE_PRICE = 100.0
NOW = "2026-07-10 12:00:00"


def rule(**over):
    base = {
        "id_group": 0, "id_currency": 0, "id_country": 0, "id_customer": 0,
        "reduction": 0, "reduction_type": "amount", "from_quantity": 1,
        "from": None, "to": None,
    }
    base.update(over)
    return base


def context(**over):
    base = {
        "customer_group_ids": {12}, "currency_id": 1, "country_id": 1,
        "customer_id": 501, "quantity": 1, "now": NOW,
    }
    base.update(over)
    return base


def test_narrow_group_row_beats_all_groups_row_when_both_match():
    rules = [
        rule(id_group=0, reduction=10),   # all groups, price 90
        rule(id_group=12, reduction=11),  # this customer's group, price 89
    ]
    result = resolve_best_specific_price(BASE_PRICE, rules, context())
    assert result["best_price"] == 89.0
    assert result["winning_rule_index"] == 1


def test_rule_scoped_to_a_different_group_is_ignored():
    rules = [rule(id_group=99, reduction=50)]
    result = resolve_best_specific_price(BASE_PRICE, rules, context())
    assert result["best_price"] == BASE_PRICE
    assert result["winning_rule_index"] is None


def test_percentage_reduction_is_computed_correctly():
    rules = [rule(id_group=0, reduction=0.20, reduction_type="percentage")]
    result = resolve_best_specific_price(BASE_PRICE, rules, context())
    assert result["best_price"] == 80.0


def test_currency_mismatch_excludes_the_rule():
    rules = [rule(id_group=0, id_currency=2, reduction=50)]
    result = resolve_best_specific_price(BASE_PRICE, rules, context(currency_id=1))
    assert result["winning_rule_index"] is None


def test_country_mismatch_excludes_the_rule():
    rules = [rule(id_group=0, id_country=9, reduction=50)]
    result = resolve_best_specific_price(BASE_PRICE, rules, context(country_id=1))
    assert result["winning_rule_index"] is None


def test_specific_customer_rule_matches_only_that_customer():
    rules = [rule(id_group=0, id_customer=501, reduction=25)]
    result = resolve_best_specific_price(BASE_PRICE, rules, context(customer_id=501))
    assert result["best_price"] == 75.0

    other = resolve_best_specific_price(BASE_PRICE, rules, context(customer_id=999))
    assert other["winning_rule_index"] is None


def test_from_quantity_tier_excludes_when_quantity_too_low():
    rules = [rule(id_group=0, reduction=30, from_quantity=5)]
    result = resolve_best_specific_price(BASE_PRICE, rules, context(quantity=1))
    assert result["winning_rule_index"] is None


def test_from_quantity_tier_included_when_quantity_meets_tier():
    rules = [rule(id_group=0, reduction=30, from_quantity=5)]
    result = resolve_best_specific_price(BASE_PRICE, rules, context(quantity=5))
    assert result["best_price"] == 70.0


def test_expired_date_window_excludes_the_rule():
    rules = [rule(id_group=0, reduction=30, to="2020-01-01 00:00:00")]
    result = resolve_best_specific_price(BASE_PRICE, rules, context())
    assert result["winning_rule_index"] is None


def test_not_yet_started_date_window_excludes_the_rule():
    rules = [rule(id_group=0, reduction=30, **{"from": "2099-01-01 00:00:00"})]
    result = resolve_best_specific_price(BASE_PRICE, rules, context())
    assert result["winning_rule_index"] is None


def test_zero_date_is_treated_as_unbounded():
    rules = [rule(id_group=0, reduction=15, to="0000-00-00 00:00:00", **{"from": "0000-00-00 00:00:00"})]
    result = resolve_best_specific_price(BASE_PRICE, rules, context())
    assert result["best_price"] == 85.0


def test_no_matching_rule_returns_base_price():
    result = resolve_best_specific_price(BASE_PRICE, [], context())
    assert result["best_price"] == BASE_PRICE
    assert result["winning_rule_index"] is None


def test_find_price_mismatch_flags_when_store_served_a_worse_price():
    assert find_price_mismatch(89.0, 90.0) is True


def test_find_price_mismatch_ignores_rounding_epsilon():
    assert find_price_mismatch(89.995, 90.0) is False


def test_find_price_mismatch_false_when_store_agrees():
    assert find_price_mismatch(89.0, 89.0) is False


def test_find_price_mismatch_false_when_store_serves_better_price():
    assert find_price_mismatch(89.0, 85.0) is False
