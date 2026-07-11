from fix_default_combination import decide_default_combination


def combo(**over):
    base = {"id": 5, "id_product": 10, "active": "1", "price": "12.00"}
    base.update(over)
    return base


def test_no_action_when_default_is_valid_and_active():
    result = decide_default_combination(10, 5, [combo(id=5)])
    assert result["action"] == "none"


def test_repairs_when_default_id_is_zero():
    result = decide_default_combination(10, 0, [combo(id=5, price="9.00"), combo(id=6, price="15.00")])
    assert result["action"] == "repair"
    assert result["target_id"] == 5


def test_repairs_when_default_id_is_blank():
    result = decide_default_combination(10, "", [combo(id=7)])
    assert result["action"] == "repair"
    assert result["target_id"] == 7


def test_repairs_when_default_points_at_deleted_combination():
    result = decide_default_combination(10, 99, [combo(id=5)])
    assert result["action"] == "repair"
    assert result["target_id"] == 5


def test_repairs_when_default_points_at_inactive_combination():
    result = decide_default_combination(10, 5, [combo(id=5, active="0"), combo(id=6, active="1")])
    assert result["action"] == "repair"
    assert result["target_id"] == 6


def test_ignores_combination_belonging_to_a_different_product():
    result = decide_default_combination(10, 5, [combo(id=5, id_product=99)])
    assert result["action"] == "flag"


def test_flags_when_no_eligible_combination_exists():
    result = decide_default_combination(10, 0, [combo(id=5, active="0")])
    assert result["action"] == "flag"
    assert result["target_id"] is None


def test_picks_cheapest_among_multiple_eligible_combinations():
    combos = [combo(id=1, price="20.00"), combo(id=2, price="8.50"), combo(id=3, price="14.00")]
    result = decide_default_combination(10, 0, combos)
    assert result["target_id"] == 2


def test_repairs_when_default_id_is_none_value():
    result = decide_default_combination(10, None, [combo(id=5)])
    assert result["action"] == "repair"
    assert result["target_id"] == 5
