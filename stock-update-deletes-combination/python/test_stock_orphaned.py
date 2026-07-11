from stock_update_deletes_combination import is_combination_stock_orphaned


def pre(**over):
    base = {"id_product_attribute": 5, "existed": True, "quantity": 10}
    base.update(over)
    return base


def post(**over):
    base = {"id_shop": 0, "id_shop_group": 2, "quantity": 10, "id_product_attribute": 5}
    base.update(over)
    return base


def group(**over):
    base = {"id_shop_group": 2, "share_stock": True}
    base.update(over)
    return base


def test_not_orphaned_when_scope_and_quantity_are_fine():
    assert is_combination_stock_orphaned(pre(), post(), group()) is False


def test_not_orphaned_when_combination_never_existed():
    assert is_combination_stock_orphaned(pre(existed=False), post(id_shop=1), group()) is False


def test_not_orphaned_when_group_does_not_share_stock():
    assert is_combination_stock_orphaned(pre(), post(id_shop=1), group(share_stock=False)) is False


def test_orphaned_when_scope_drifted_off_zero():
    assert is_combination_stock_orphaned(pre(), post(id_shop=1), group()) is True


def test_orphaned_when_quantity_collapsed_to_zero():
    assert is_combination_stock_orphaned(pre(quantity=10), post(quantity=0), group()) is True


def test_not_orphaned_when_quantity_was_already_zero():
    assert is_combination_stock_orphaned(pre(quantity=0), post(quantity=0), group()) is False


def test_orphaned_when_both_scope_drifted_and_quantity_collapsed():
    assert is_combination_stock_orphaned(pre(quantity=10), post(id_shop=1, quantity=0), group()) is True


def test_not_orphaned_when_shop_group_id_differs_but_still_shares_stock():
    # id_shop_group on the row is informational for lookup, not part of the decision itself
    assert is_combination_stock_orphaned(pre(), post(id_shop=0, id_shop_group=9), group(id_shop_group=9)) is False
