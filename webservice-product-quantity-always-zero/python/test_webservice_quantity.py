from sync_stock_quantity import decide_quantity_sync


def test_legacy_field_never_trusted_even_when_nonzero():
    # Even if products.quantity somehow carried a nonzero value, it must be ignored.
    result = decide_quantity_sync(99, 5, True, "both", dry_run=True)
    assert result["status"] == "ignore_legacy_field"
    assert result["action"] == "none"


def test_flags_when_no_stock_available_row_found():
    result = decide_quantity_sync(0, None, True, "both", dry_run=True)
    assert result["action"] == "flag"
    assert "no stock_availables row" in result["reason"]


def test_no_action_when_real_quantity_is_healthy():
    result = decide_quantity_sync(0, 12, True, "both", dry_run=True)
    assert result["action"] == "none"


def test_flags_zero_stock_on_active_visible_product_when_expected_positive():
    result = decide_quantity_sync(0, 0, True, "both", dry_run=True, expected_positive=True)
    assert result["action"] == "flag"


def test_no_repair_when_product_is_inactive():
    result = decide_quantity_sync(0, 0, False, "both", dry_run=True, expected_positive=True)
    assert result["action"] == "none"


def test_no_repair_when_visibility_is_none():
    result = decide_quantity_sync(0, 0, True, "none", dry_run=True, expected_positive=True)
    assert result["action"] == "none"


def test_patches_when_dry_run_off_and_target_known():
    result = decide_quantity_sync(0, 0, True, "both", dry_run=False,
                                   expected_positive=True, target_quantity=10)
    assert result["action"] == "patch_stock_available"
    assert result["target_quantity"] == 10


def test_flags_instead_of_patching_when_dry_run_on():
    result = decide_quantity_sync(0, 0, True, "both", dry_run=True,
                                   expected_positive=True, target_quantity=10)
    assert result["action"] == "flag"


def test_flags_instead_of_patching_when_target_quantity_unknown():
    result = decide_quantity_sync(0, 0, True, "both", dry_run=False,
                                   expected_positive=True, target_quantity=None)
    assert result["action"] == "flag"


def test_negative_real_quantity_on_active_visible_product_is_flagged():
    result = decide_quantity_sync(0, -3, True, "catalog", dry_run=True, expected_positive=True)
    assert result["action"] == "flag"
