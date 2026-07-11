from audit_paid_out_of_stock import decide_out_of_stock_paid_flag

PAID_IDS = [2, 12]


def test_paid_qty_zero_deny_is_flagged():
    lines = [{"productId": 1, "productAttributeId": 0, "productQuantity": 1}]
    stock = {"1:0": {"quantity": 0, "outOfStock": 0}}
    result = decide_out_of_stock_paid_flag(101, 2, PAID_IDS, lines, stock)
    assert result["flagged"] is True
    assert len(result["reasons"]) == 1


def test_paid_qty_five_deny_not_flagged():
    lines = [{"productId": 1, "productAttributeId": 0, "productQuantity": 1}]
    stock = {"1:0": {"quantity": 5, "outOfStock": 0}}
    result = decide_out_of_stock_paid_flag(102, 2, PAID_IDS, lines, stock)
    assert result["flagged"] is False


def test_paid_qty_negative_allow_backorder_not_flagged():
    lines = [{"productId": 1, "productAttributeId": 0, "productQuantity": 1}]
    stock = {"1:0": {"quantity": -2, "outOfStock": 1}}
    result = decide_out_of_stock_paid_flag(103, 2, PAID_IDS, lines, stock)
    assert result["flagged"] is False


def test_not_paid_never_flagged_regardless_of_stock():
    lines = [{"productId": 1, "productAttributeId": 0, "productQuantity": 1}]
    stock = {"1:0": {"quantity": -5, "outOfStock": 0}}
    result = decide_out_of_stock_paid_flag(104, 1, PAID_IDS, lines, stock)
    assert result["flagged"] is False
    assert result["reasons"] == []


def test_multiple_lines_one_insufficient_flags_with_one_reason():
    lines = [
        {"productId": 1, "productAttributeId": 0, "productQuantity": 1},
        {"productId": 2, "productAttributeId": 0, "productQuantity": 2},
    ]
    stock = {
        "1:0": {"quantity": 10, "outOfStock": 0},
        "2:0": {"quantity": 0, "outOfStock": 0},
    }
    result = decide_out_of_stock_paid_flag(105, 12, PAID_IDS, lines, stock)
    assert result["flagged"] is True
    assert len(result["reasons"]) == 1
    assert "2:0" in result["reasons"][0]


def test_quantity_exactly_equals_needed_not_flagged():
    lines = [{"productId": 1, "productAttributeId": 0, "productQuantity": 3}]
    stock = {"1:0": {"quantity": 3, "outOfStock": 0}}
    result = decide_out_of_stock_paid_flag(106, 2, PAID_IDS, lines, stock)
    assert result["flagged"] is False
