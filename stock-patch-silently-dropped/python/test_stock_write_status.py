from stock_patch_guard import decide_write_status


def test_applied_when_post_matches_attempted():
    assert decide_write_status(10, 25, 25, False, "PATCH") == "applied"


def test_no_op_when_attempted_equals_pre():
    assert decide_write_status(10, 10, 10, False, "PATCH") == "no_op"


def test_silently_dropped_redirect_when_redirected_and_final_get():
    assert decide_write_status(10, 25, 10, True, "GET") == "silently_dropped_redirect"


def test_silently_dropped_other_when_not_redirected_but_unchanged():
    assert decide_write_status(10, 25, 10, False, "PATCH") == "silently_dropped_other"


def test_silently_dropped_other_when_redirected_but_final_method_not_get():
    assert decide_write_status(10, 25, 10, True, "PATCH") == "silently_dropped_other"


def test_applied_takes_priority_over_redirected_flag():
    assert decide_write_status(10, 25, 25, True, "GET") == "applied"


def test_no_op_takes_priority_even_if_redirected():
    assert decide_write_status(10, 10, 10, True, "GET") == "no_op"


def test_final_method_is_case_insensitive():
    assert decide_write_status(10, 25, 10, True, "get") == "silently_dropped_redirect"


def test_negative_delta_still_detected_as_dropped():
    assert decide_write_status(25, 10, 25, True, "GET") == "silently_dropped_redirect"
