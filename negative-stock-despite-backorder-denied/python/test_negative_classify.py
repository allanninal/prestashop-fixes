from reconcile_negative_stock import classify_stock_violation


def test_deny_and_negative_is_violation():
    result = classify_stock_violation(-3, 0, True)
    assert result == {"policy": "deny", "is_violation": True, "clamp_to": 0}


def test_allow_and_negative_is_not_violation():
    result = classify_stock_violation(-3, 1, True)
    assert result["is_violation"] is False
    assert result["clamp_to"] is None


def test_deny_and_positive_is_not_violation():
    result = classify_stock_violation(5, 0, True)
    assert result["is_violation"] is False


def test_default_inherits_deny_from_global():
    result = classify_stock_violation(-2, 2, True)
    assert result["policy"] == "deny"
    assert result["is_violation"] is True
    assert result["clamp_to"] == 0


def test_default_inherits_allow_from_global():
    result = classify_stock_violation(-2, 2, False)
    assert result["policy"] == "allow"
    assert result["is_violation"] is False
    assert result["clamp_to"] is None


def test_clamp_to_uses_max_of_quantity_and_zero():
    result = classify_stock_violation(-7, 0, True)
    assert result["clamp_to"] == 0


def test_zero_quantity_with_deny_is_not_violation():
    result = classify_stock_violation(0, 0, True)
    assert result["is_violation"] is False
    assert result["clamp_to"] is None


def test_allow_policy_ignores_global_default():
    result = classify_stock_violation(-10, 1, False)
    assert result["policy"] == "allow"
    assert result["is_violation"] is False
