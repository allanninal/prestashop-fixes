from audit_guest_voucher_reuse import find_overused_vouchers

RULE = {"id": 42, "code": "WELCOME10", "quantity_per_user": 1, "quantity": 500}


def order(**over):
    base = {"id": 1, "id_customer": 10, "current_state": 2}
    base.update(over)
    return base


def customer(id_, email):
    return {"id": id_, "email": email}


def link(id_order, id_cart_rule=42):
    return {"id_cart_rule": id_cart_rule, "id_order": id_order}


def test_no_overage_when_email_used_once():
    orders = [order(id=1, id_customer=10)]
    customers = [customer(10, "same@example.com")]
    result = find_overused_vouchers([RULE], [link(1)], orders, customers)
    assert result == []


def test_flags_same_email_across_different_guest_customers():
    orders = [
        order(id=1, id_customer=10),
        order(id=2, id_customer=11),
        order(id=3, id_customer=12),
    ]
    customers = [
        customer(10, "same@example.com"),
        customer(11, "same@example.com"),
        customer(12, "same@example.com"),
    ]
    links = [link(1), link(2), link(3)]
    result = find_overused_vouchers([RULE], links, orders, customers)
    assert len(result) == 1
    assert result[0]["email"] == "same@example.com"
    assert result[0]["actual_uses"] == 3
    assert result[0]["id_orders"] == [1, 2, 3]


def test_different_emails_are_not_grouped_together():
    orders = [order(id=1, id_customer=10), order(id=2, id_customer=11)]
    customers = [customer(10, "a@example.com"), customer(11, "b@example.com")]
    links = [link(1), link(2)]
    result = find_overused_vouchers([RULE], links, orders, customers)
    assert result == []


def test_excludes_cancelled_and_error_orders():
    orders = [
        order(id=1, id_customer=10, current_state=2),
        order(id=2, id_customer=11, current_state=8),  # PS_OS_CANCELED
    ]
    customers = [customer(10, "same@example.com"), customer(11, "same@example.com")]
    links = [link(1), link(2)]
    result = find_overused_vouchers([RULE], links, orders, customers)
    assert result == []


def test_respects_higher_quantity_per_user():
    rule = {"id": 7, "code": "VIP2", "quantity_per_user": 2, "quantity": 50}
    orders = [order(id=1, id_customer=10), order(id=2, id_customer=11)]
    customers = [customer(10, "same@example.com"), customer(11, "same@example.com")]
    links = [link(1, 7), link(2, 7)]
    result = find_overused_vouchers([rule], links, orders, customers)
    assert result == []


def test_flagged_list_sorted_by_cart_rule_then_email():
    orders = [
        order(id=1, id_customer=10),
        order(id=2, id_customer=11),
        order(id=3, id_customer=12),
        order(id=4, id_customer=13),
    ]
    customers = [
        customer(10, "z@example.com"),
        customer(11, "z@example.com"),
        customer(12, "a@example.com"),
        customer(13, "a@example.com"),
    ]
    links = [link(1), link(2), link(3), link(4)]
    result = find_overused_vouchers([RULE], links, orders, customers)
    emails = [entry["email"] for entry in result]
    assert emails == sorted(emails)


def test_unknown_cart_rule_id_is_skipped():
    orders = [order(id=1, id_customer=10), order(id=2, id_customer=11)]
    customers = [customer(10, "same@example.com"), customer(11, "same@example.com")]
    links = [link(1, 999), link(2, 999)]  # 999 not in cart_rules list
    result = find_overused_vouchers([RULE], links, orders, customers)
    assert result == []


def test_order_missing_customer_id_is_excluded():
    orders = [order(id=1, id_customer=None), order(id=2, id_customer=None)]
    customers = []
    links = [link(1), link(2)]
    result = find_overused_vouchers([RULE], links, orders, customers)
    assert result == []
