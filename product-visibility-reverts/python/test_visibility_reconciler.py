from reconcile_visibility import decide_visibility_action


def test_no_action_when_actual_matches_intended():
    intended = {(1, 1): "none"}
    actual = {(1, 1): "none"}
    result = decide_visibility_action(intended, actual, set())
    assert result[0]["action"] == "none"


def test_reapply_when_drifted_and_never_repaired():
    intended = {(1, 1): "none"}
    actual = {(1, 1): "both"}
    result = decide_visibility_action(intended, actual, set())
    assert result[0]["action"] == "reapply"
    assert result[0]["intended"] == "none"
    assert result[0]["actual"] == "both"


def test_flag_when_drifted_again_after_a_repair():
    intended = {(1, 1): "none"}
    actual = {(1, 1): "both"}
    result = decide_visibility_action(intended, actual, {(1, 1)})
    assert result[0]["action"] == "flag"


def test_missing_actual_value_is_treated_as_drift():
    intended = {(2, 3): "catalog"}
    actual = {}
    result = decide_visibility_action(intended, actual, set())
    assert result[0]["action"] == "reapply"
    assert result[0]["actual"] is None


def test_handles_multiple_pairs_independently():
    intended = {(1, 1): "none", (2, 1): "search", (3, 1): "both"}
    actual = {(1, 1): "both", (2, 1): "search", (3, 1): "both"}
    result = decide_visibility_action(intended, actual, {(1, 1)})
    by_key = {(d["product_id"], d["id_shop"]): d["action"] for d in result}
    assert by_key[(1, 1)] == "flag"
    assert by_key[(2, 1)] == "none"
    assert by_key[(3, 1)] == "none"


def test_returns_one_decision_per_intended_key():
    intended = {(1, 1): "none", (1, 2): "both"}
    actual = {(1, 1): "none", (1, 2): "both"}
    result = decide_visibility_action(intended, actual, set())
    assert len(result) == 2


def test_no_network_or_side_effects():
    # decide_visibility_action must be pure: same inputs, same output, no I/O.
    intended = {(9, 1): "search"}
    actual = {(9, 1): "search"}
    first = decide_visibility_action(intended, actual, set())
    second = decide_visibility_action(intended, actual, set())
    assert first == second


def test_flag_key_not_present_in_already_repaired_once_defaults_to_reapply():
    intended = {(4, 2): "search"}
    actual = {(4, 2): "none"}
    result = decide_visibility_action(intended, actual, {(9, 9)})
    assert result[0]["action"] == "reapply"
