from detect_restock_alerts import decide_restock_alert


def test_flags_when_zero_to_positive_on_active_visible_product():
    result = decide_restock_alert(0, 5, True, "both")
    assert result["action"] == "flag_restock_alert"


def test_flags_when_negative_to_positive_on_active_visible_product():
    result = decide_restock_alert(-2, 3, True, "both")
    assert result["action"] == "flag_restock_alert"


def test_record_only_when_no_prior_quantity():
    result = decide_restock_alert(None, 5, True, "both")
    assert result["action"] == "record_only"
    assert "no prior quantity" in result["reason"]


def test_record_only_when_no_current_row():
    result = decide_restock_alert(0, None, True, "both")
    assert result["action"] == "record_only"
    assert "no stock_availables row" in result["reason"]


def test_record_only_when_quantity_stays_positive():
    result = decide_restock_alert(5, 8, True, "both")
    assert result["action"] == "record_only"


def test_record_only_when_quantity_drops_to_zero():
    result = decide_restock_alert(5, 0, True, "both")
    assert result["action"] == "record_only"


def test_record_only_when_product_inactive():
    result = decide_restock_alert(0, 5, False, "both")
    assert result["action"] == "record_only"


def test_record_only_when_visibility_none():
    result = decide_restock_alert(0, 5, True, "none")
    assert result["action"] == "record_only"


def test_record_only_when_quantity_stays_at_or_below_zero():
    result = decide_restock_alert(0, 0, True, "both")
    assert result["action"] == "record_only"
