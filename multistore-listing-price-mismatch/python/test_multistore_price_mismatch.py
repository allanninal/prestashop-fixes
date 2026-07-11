from decimal import Decimal
from diagnose_multistore_listing_price import decide_price_mismatch


def test_no_mismatch_when_prices_equal():
    result = decide_price_mismatch(Decimal("19.99"), Decimal("19.99"), 42, 1)
    assert result["mismatch"] is False
    assert result["diff"] == Decimal("0.00")


def test_no_mismatch_within_rounding_tolerance():
    result = decide_price_mismatch(Decimal("19.995"), Decimal("19.99"), 42, 1, Decimal("0.01"))
    assert result["mismatch"] is False


def test_mismatch_when_prices_differ_beyond_tolerance():
    result = decide_price_mismatch(Decimal("24.99"), Decimal("19.99"), 42, 2)
    assert result["mismatch"] is True
    assert result["diff"] == Decimal("5.00")


def test_mismatch_direction_does_not_matter():
    a = decide_price_mismatch(Decimal("19.99"), Decimal("24.99"), 42, 2)
    b = decide_price_mismatch(Decimal("24.99"), Decimal("19.99"), 42, 2)
    assert a["mismatch"] is True and b["mismatch"] is True
    assert a["diff"] == b["diff"]


def test_custom_tolerance_is_respected():
    result = decide_price_mismatch(Decimal("19.99"), Decimal("20.09"), 7, 3, Decimal("0.20"))
    assert result["mismatch"] is False


def test_result_carries_ids_and_prices():
    result = decide_price_mismatch(Decimal("10.00"), Decimal("12.00"), 99, 5)
    assert result["id_product"] == 99
    assert result["id_shop"] == 5
    assert result["listing_price"] == Decimal("10.00")
    assert result["single_product_price"] == Decimal("12.00")
