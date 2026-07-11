from reserved_quantity_drift import compute_reserved_drift

LOGABLE = {2}  # only order state id 2 counts as a pending reservation


def line(**over):
    base = {
        "id_product": 10,
        "id_product_attribute": 0,
        "product_quantity": 2,
        "product_quantity_refunded": 0,
        "id_order_state": 2,
    }
    base.update(over)
    return base


def stock_row(**over):
    base = {"id_product": 10, "id_product_attribute": 0, "reserved_quantity": 2}
    base.update(over)
    return base


def test_no_drift_when_expected_matches_actual():
    assert compute_reserved_drift([line()], LOGABLE, [stock_row()]) == []


def test_drift_when_reserved_quantity_stuck_after_cancellation():
    # no open orders at all, but the stock row still holds reserved units
    result = compute_reserved_drift([], LOGABLE, [stock_row(reserved_quantity=3)])
    assert result == [{
        "id_product": 10,
        "id_product_attribute": 0,
        "expected_reserved": 0,
        "actual_reserved": 3,
        "drift": 3,
    }]


def test_zero_orders_and_zero_stock_produces_no_drift():
    assert compute_reserved_drift([], LOGABLE, []) == []


def test_refunded_partial_line_reduces_expected_reserved():
    l = line(product_quantity=5, product_quantity_refunded=3)  # 2 remaining
    assert compute_reserved_drift([l], LOGABLE, [stock_row(reserved_quantity=2)]) == []
    assert compute_reserved_drift([l], LOGABLE, [stock_row(reserved_quantity=5)]) == [{
        "id_product": 10,
        "id_product_attribute": 0,
        "expected_reserved": 2,
        "actual_reserved": 5,
        "drift": 3,
    }]


def test_non_logable_state_is_excluded_from_expected():
    l = line(id_order_state=99)  # not in LOGABLE
    result = compute_reserved_drift([l], LOGABLE, [stock_row(reserved_quantity=2)])
    assert result == [{
        "id_product": 10,
        "id_product_attribute": 0,
        "expected_reserved": 0,
        "actual_reserved": 2,
        "drift": 2,
    }]


def test_multiple_attributes_per_product_are_tracked_separately():
    lines = [
        line(id_product_attribute=1, product_quantity=1),
        line(id_product_attribute=2, product_quantity=4),
    ]
    rows = [
        stock_row(id_product_attribute=1, reserved_quantity=1),
        stock_row(id_product_attribute=2, reserved_quantity=9),
    ]
    result = compute_reserved_drift(lines, LOGABLE, rows)
    assert result == [{
        "id_product": 10,
        "id_product_attribute": 2,
        "expected_reserved": 4,
        "actual_reserved": 9,
        "drift": 5,
    }]


def test_negative_remaining_is_clipped_to_zero():
    # refunded more than ordered should never produce a negative expected reservation
    l = line(product_quantity=2, product_quantity_refunded=5)
    result = compute_reserved_drift([l], LOGABLE, [stock_row(reserved_quantity=0)])
    assert result == []
