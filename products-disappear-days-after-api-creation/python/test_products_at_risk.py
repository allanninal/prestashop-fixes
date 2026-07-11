from detect_and_repair_delisted_products import is_product_at_risk_of_delisting


def test_healthy_product_is_not_at_risk():
    at_risk, reasons = is_product_at_risk_of_delisting("1", "both", 3, [2, 3], 12, 0)
    assert at_risk is False
    assert reasons == []


def test_flags_when_inactive():
    at_risk, reasons = is_product_at_risk_of_delisting("0", "both", 3, [2, 3], 12, 0)
    assert at_risk is True
    assert any("active" in r for r in reasons)


def test_flags_when_visibility_is_none():
    at_risk, reasons = is_product_at_risk_of_delisting("1", "none", 3, [2, 3], 12, 0)
    assert at_risk is True
    assert any("visibility" in r for r in reasons)


def test_visibility_catalog_is_allowed():
    at_risk, _ = is_product_at_risk_of_delisting("1", "catalog", 3, [2, 3], 12, 0)
    assert at_risk is False


def test_flags_when_id_category_default_is_zero():
    at_risk, reasons = is_product_at_risk_of_delisting("1", "both", 0, [2, 3], 12, 0)
    assert at_risk is True
    assert any("id_category_default is 0" in r for r in reasons)


def test_flags_when_category_ids_empty():
    at_risk, reasons = is_product_at_risk_of_delisting("1", "both", 3, [], 12, 0)
    assert at_risk is True
    assert any("empty" in r for r in reasons)


def test_flags_when_default_category_not_in_category_ids():
    at_risk, reasons = is_product_at_risk_of_delisting("1", "both", 9, [2, 3], 12, 0)
    assert at_risk is True
    assert any("not in associations.categories" in r for r in reasons)


def test_flags_when_out_of_stock_and_denying_orders():
    at_risk, reasons = is_product_at_risk_of_delisting("1", "both", 3, [2, 3], 0, 2)
    assert at_risk is True
    assert any("out of stock" in r for r in reasons)


def test_out_of_stock_but_backorder_allowed_is_not_flagged_for_stock():
    at_risk, reasons = is_product_at_risk_of_delisting("1", "both", 3, [2, 3], 0, 1)
    assert at_risk is False


def test_multiple_reasons_can_stack():
    at_risk, reasons = is_product_at_risk_of_delisting("0", "none", 0, [], 0, 2)
    assert at_risk is True
    assert len(reasons) == 5
