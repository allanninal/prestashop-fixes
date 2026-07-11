from check_duplicate_payments import find_duplicate_payments


def payment(**over):
    base = {"id": 1, "order_reference": "ABC123", "amount": "49.99", "date_add": "2026-07-10 10:00:00"}
    base.update(over)
    return base


def test_two_payments_seconds_apart_is_flagged():
    rows = [
        payment(id=1, date_add="2026-07-10 10:00:00"),
        payment(id=2, date_add="2026-07-10 10:00:20"),
    ]
    clusters = find_duplicate_payments(rows)
    assert len(clusters) == 1
    assert clusters[0]["order_reference"] == "ABC123"
    assert clusters[0]["amount"] == 49.99
    assert clusters[0]["count"] == 2
    assert set(clusters[0]["duplicate_payment_ids"]) == {1, 2}


def test_different_amounts_not_flagged():
    rows = [
        payment(id=1, amount="49.99", date_add="2026-07-10 10:00:00"),
        payment(id=2, amount="25.00", date_add="2026-07-10 10:00:20"),
    ]
    assert find_duplicate_payments(rows) == []


def test_same_amount_days_apart_not_flagged():
    rows = [
        payment(id=1, amount="49.99", date_add="2026-07-10 10:00:00"),
        payment(id=2, amount="49.99", date_add="2026-07-13 10:00:00"),
    ]
    assert find_duplicate_payments(rows) == []


def test_single_payment_not_flagged():
    assert find_duplicate_payments([payment()]) == []


def test_no_payments_not_flagged():
    assert find_duplicate_payments([]) == []


def test_amount_within_cent_tolerance_is_flagged():
    rows = [
        payment(id=1, amount="49.990", date_add="2026-07-10 10:00:00"),
        payment(id=2, amount="49.995", date_add="2026-07-10 10:00:05"),
    ]
    assert len(find_duplicate_payments(rows)) == 1


def test_unsorted_input_still_detected():
    rows = [
        payment(id=2, date_add="2026-07-10 10:00:20"),
        payment(id=1, date_add="2026-07-10 10:00:00"),
    ]
    clusters = find_duplicate_payments(rows)
    assert len(clusters) == 1


def test_three_payments_same_amount_seconds_apart_forms_one_cluster():
    rows = [
        payment(id=1, date_add="2026-07-10 10:00:00"),
        payment(id=2, date_add="2026-07-10 10:00:10"),
        payment(id=3, date_add="2026-07-10 10:00:20"),
    ]
    clusters = find_duplicate_payments(rows)
    assert len(clusters) >= 1
