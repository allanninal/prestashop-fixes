from check_free_shipping import decide_free_shipping_violation

DATE_FROM = "2026-07-01 00:00:00"
DATE_TO = "2026-07-31 23:59:59"


def cart_rule(**over):
    base = {
        "id": 7,
        "code": "FREESHIP",
        "active": True,
        "free_shipping": True,
        "carrier_restriction": None,
        "date_from": DATE_FROM,
        "date_to": DATE_TO,
    }
    base.update(over)
    return base


def order(**over):
    base = {
        "id_carrier": 2,
        "date_add": "2026-07-15 10:00:00",
        "total_shipping_tax_incl": "5.99",
    }
    base.update(over)
    return base


def test_flags_when_eligible_and_shipping_nonzero():
    assert decide_free_shipping_violation(cart_rule(), order(), {}) is True


def test_no_violation_when_shipping_already_zero():
    assert decide_free_shipping_violation(cart_rule(), order(total_shipping_tax_incl="0.00"), {}) is False


def test_no_violation_when_rule_inactive():
    assert decide_free_shipping_violation(cart_rule(active=False), order(), {}) is False


def test_no_violation_when_free_shipping_not_set():
    assert decide_free_shipping_violation(cart_rule(free_shipping=False), order(), {}) is False


def test_no_violation_when_order_date_outside_window():
    assert decide_free_shipping_violation(cart_rule(), order(date_add="2026-08-05 00:00:00"), {}) is False


def test_no_violation_when_carrier_excluded_by_restriction():
    rule = cart_rule(carrier_restriction=[3, 4])
    assert decide_free_shipping_violation(rule, order(id_carrier=2), {}) is False


def test_flags_when_carrier_is_in_restriction_list():
    rule = cart_rule(carrier_restriction=[2, 3])
    assert decide_free_shipping_violation(rule, order(id_carrier=2), {}) is True


def test_no_violation_when_missing_order_date():
    assert decide_free_shipping_violation(cart_rule(), order(date_add=None), {}) is False


def test_exactly_at_date_to_is_still_eligible():
    o = order(date_add=DATE_TO)
    assert decide_free_shipping_violation(cart_rule(), o, {}) is True


def test_exactly_at_date_from_is_still_eligible():
    o = order(date_add=DATE_FROM)
    assert decide_free_shipping_violation(cart_rule(), o, {}) is True
