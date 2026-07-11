from check_duplicate_invoice_numbers import find_duplicate_invoice_numbers


def invoice(**over):
    base = {"id": 1, "id_order": 100, "number": 1042, "date_add": "2026-07-10 10:00:00"}
    base.update(over)
    return base


def test_no_collisions():
    rows = [
        invoice(id=1, id_order=100, number=1042),
        invoice(id=2, id_order=101, number=1043),
    ]
    assert find_duplicate_invoice_numbers(rows) == []


def test_one_collision_pair():
    rows = [
        invoice(id=1, id_order=100, number=1042, date_add="2026-07-10 10:00:00"),
        invoice(id=2, id_order=101, number=1042, date_add="2026-07-10 10:00:02"),
    ]
    collisions = find_duplicate_invoice_numbers(rows)
    assert len(collisions) == 1
    assert collisions[0]["number"] == 1042
    assert set(collisions[0]["orders"]) == {100, 101}
    assert set(collisions[0]["invoice_ids"]) == {1, 2}


def test_same_order_refetched_twice_is_not_a_collision():
    rows = [
        invoice(id=1, id_order=100, number=1042, date_add="2026-07-10 10:00:00"),
        invoice(id=1, id_order=100, number=1042, date_add="2026-07-10 10:00:00"),
    ]
    assert find_duplicate_invoice_numbers(rows) == []


def test_three_way_collision():
    rows = [
        invoice(id=1, id_order=100, number=1042),
        invoice(id=2, id_order=101, number=1042),
        invoice(id=3, id_order=102, number=1042),
    ]
    collisions = find_duplicate_invoice_numbers(rows)
    assert len(collisions) == 1
    assert set(collisions[0]["orders"]) == {100, 101, 102}
    assert len(collisions[0]["invoice_ids"]) == 3


def test_no_invoices_no_collisions():
    assert find_duplicate_invoice_numbers([]) == []


def test_multiple_independent_collisions_are_both_reported():
    rows = [
        invoice(id=1, id_order=100, number=1042),
        invoice(id=2, id_order=101, number=1042),
        invoice(id=3, id_order=200, number=2001),
        invoice(id=4, id_order=201, number=2001),
    ]
    collisions = find_duplicate_invoice_numbers(rows)
    assert len(collisions) == 2
    numbers = {c["number"] for c in collisions}
    assert numbers == {1042, 2001}
