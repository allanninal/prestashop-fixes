from swap_default_combination import plan_default_swap, current_default_id


def row(**over):
    base = {"id": 1, "default_on": 0}
    base.update(over)
    return base


def test_no_steps_when_target_already_default():
    assert plan_default_swap(5, 5) == []


def test_clears_old_default_before_setting_new_one():
    steps = plan_default_swap(5, 9)
    assert steps == [{"id": 5, "default_on": 0}, {"id": 9, "default_on": 1}]


def test_order_is_always_clear_then_set():
    steps = plan_default_swap(3, 4)
    assert steps[0]["default_on"] == 0
    assert steps[1]["default_on"] == 1
    assert steps[0]["id"] != steps[1]["id"]


def test_handles_missing_current_default():
    steps = plan_default_swap(None, 7)
    assert steps == [{"id": 7, "default_on": 1}]


def test_current_default_id_finds_the_flagged_row():
    rows = [row(id=1, default_on=0), row(id=2, default_on=1), row(id=3, default_on=0)]
    assert current_default_id(rows) == 2


def test_current_default_id_returns_none_when_nobody_is_flagged():
    rows = [row(id=1, default_on=0), row(id=2, default_on=0)]
    assert current_default_id(rows) is None


def test_current_default_id_on_empty_list():
    assert current_default_id([]) is None


def test_plan_is_idempotent_when_rerun_after_swap():
    # After swapping from 5 to 9, re-planning with 9 as both current and target is a no-op.
    first = plan_default_swap(5, 9)
    assert first
    second = plan_default_swap(9, 9)
    assert second == []
