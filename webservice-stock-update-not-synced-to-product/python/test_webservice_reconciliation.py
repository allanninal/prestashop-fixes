from webservice_stock_resync import decide_reconciliation


def test_in_sync_when_values_match():
    result = decide_reconciliation(10, 10, 0, 1)
    assert result == {"status": "in_sync", "action": "none", "delta": 0}


def test_stuck_zero_resyncs_when_depends_on_stock():
    result = decide_reconciliation(0, 25, 0, 1)
    assert result == {"status": "stuck_zero", "action": "resync_display_only", "delta": 25}


def test_stuck_zero_flags_when_not_depends_on_stock():
    result = decide_reconciliation(0, 25, 0, 0)
    assert result == {"status": "stuck_zero", "action": "flag_for_review", "delta": 25}


def test_stale_product_field_resyncs_when_depends_on_stock():
    result = decide_reconciliation(8, 12, 0, 1)
    assert result == {"status": "stale_product_field", "action": "resync_display_only", "delta": 4}


def test_stale_product_field_flags_when_not_depends_on_stock():
    result = decide_reconciliation(8, 12, 0, 0)
    assert result == {"status": "stale_product_field", "action": "flag_for_review", "delta": 4}


def test_negative_delta_is_stale_product_field_not_stuck_zero():
    result = decide_reconciliation(20, 5, 0, 1)
    assert result == {"status": "stale_product_field", "action": "resync_display_only", "delta": -15}


def test_zero_and_zero_is_in_sync():
    result = decide_reconciliation(0, 0, 0, 1)
    assert result == {"status": "in_sync", "action": "none", "delta": 0}


def test_out_of_stock_flag_does_not_change_the_decision():
    # out_of_stock is captured for context only; it does not gate the decision itself
    a = decide_reconciliation(0, 5, 0, 1)
    b = decide_reconciliation(0, 5, 2, 1)
    assert a == b == {"status": "stuck_zero", "action": "resync_display_only", "delta": 5}
