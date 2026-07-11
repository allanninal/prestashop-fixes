from backfill_missing_invoice import decide_invoice_repair


def order(**over):
    base = {"id": 501, "reference": "ABCDE12345", "valid": True, "current_state": 4}
    base.update(over)
    return base


def test_generates_invoice_when_eligible_enabled_and_missing():
    result = decide_invoice_repair(order(), True, True, [])
    assert result["action"] == "generate_invoice"
    assert result["reason"] == "eligible_state_missing_invoice"


def test_none_when_invoice_already_exists():
    result = decide_invoice_repair(order(), True, True, [{"id": 9, "number": 1042}])
    assert result["action"] == "none"
    assert result["reason"] == "invoice_already_exists"


def test_skips_when_state_not_invoice_eligible():
    result = decide_invoice_repair(order(), False, True, [])
    assert result["action"] == "skip"
    assert result["reason"] == "current_state_not_invoice_eligible"


def test_skips_when_ps_invoice_disabled():
    result = decide_invoice_repair(order(), True, False, [])
    assert result["action"] == "skip"
    assert result["reason"] == "ps_invoice_disabled"


def test_flags_when_order_not_valid():
    result = decide_invoice_repair(order(valid=False), True, True, [])
    assert result["action"] == "flag_manual_review"
    assert result["reason"] == "order_not_valid_yet"


def test_ps_invoice_disabled_wins_over_ineligible_state():
    result = decide_invoice_repair(order(), False, False, [])
    assert result["action"] == "skip"
    assert result["reason"] == "ps_invoice_disabled"


def test_empty_invoices_list_is_treated_as_missing():
    result = decide_invoice_repair(order(), True, True, [])
    assert result["action"] == "generate_invoice"


def test_none_wins_over_flag_when_invoice_exists_on_invalid_order():
    # Existing invoice check happens before the valid check, so this stays "none".
    result = decide_invoice_repair(order(valid=False), True, True, [{"id": 1}])
    assert result["action"] == "none"
    assert result["reason"] == "invoice_already_exists"
