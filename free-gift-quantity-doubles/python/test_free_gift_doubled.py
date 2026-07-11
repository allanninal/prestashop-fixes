from find_doubled_gift_lines import find_doubled_gift_lines, is_pure_gift_row

GIFT_RULE = {"id_cart_rule": 42, "gift_product": 501, "gift_product_attribute": 0, "code": ""}


def cart_row(**over):
    base = {"id_product": 501, "id_product_attribute": 0, "quantity": 1}
    base.update(over)
    return base


def test_no_finding_when_gift_quantity_is_one():
    rows = [cart_row()]
    assert find_doubled_gift_lines(rows, [GIFT_RULE]) == []


def test_finding_when_gift_quantity_doubles():
    rows = [cart_row(quantity=2)]
    findings = find_doubled_gift_lines(rows, [GIFT_RULE])
    assert len(findings) == 1
    assert findings[0]["quantity"] == 2
    assert findings[0]["id_cart_rule"] == 42
    assert findings[0]["is_automatic"] is True


def test_no_finding_when_row_does_not_match_any_gift_rule():
    rows = [cart_row(id_product=999, quantity=2)]
    assert find_doubled_gift_lines(rows, [GIFT_RULE]) == []


def test_no_finding_when_gift_product_is_zero():
    rule = {"id_cart_rule": 7, "gift_product": 0, "gift_product_attribute": 0, "code": ""}
    rows = [cart_row(quantity=2)]
    assert find_doubled_gift_lines(rows, [rule]) == []


def test_is_automatic_false_when_rule_has_a_code():
    rule = {"id_cart_rule": 9, "gift_product": 501, "gift_product_attribute": 0, "code": "SUMMER1"}
    rows = [cart_row(quantity=2)]
    findings = find_doubled_gift_lines(rows, [rule])
    assert findings[0]["is_automatic"] is False


def test_matches_on_product_attribute_pair_not_just_product():
    rule = {"id_cart_rule": 5, "gift_product": 501, "gift_product_attribute": 3, "code": ""}
    rows = [cart_row(id_product_attribute=3, quantity=2), cart_row(id_product_attribute=4, quantity=2)]
    findings = find_doubled_gift_lines(rows, [rule])
    assert len(findings) == 1
    assert findings[0]["id_product_attribute"] == 3


def test_no_finding_when_quantity_exactly_one_across_multiple_rules():
    rules = [GIFT_RULE, {"id_cart_rule": 6, "gift_product": 777, "gift_product_attribute": 0, "code": ""}]
    rows = [cart_row(quantity=1), cart_row(id_product=777, quantity=1)]
    assert find_doubled_gift_lines(rows, rules) == []


def test_is_pure_gift_row_true_when_only_one_matching_row():
    rows = [cart_row(quantity=2)]
    assert is_pure_gift_row(rows, 501, 0, 2) is True


def test_is_pure_gift_row_false_when_a_separate_non_gift_row_exists():
    rows = [cart_row(quantity=2), cart_row(id_product=501, id_product_attribute=0, quantity=1)]
    assert is_pure_gift_row(rows, 501, 0, 2) is False


def test_is_pure_gift_row_false_when_quantity_does_not_match():
    rows = [cart_row(quantity=3)]
    assert is_pure_gift_row(rows, 501, 0, 2) is False
