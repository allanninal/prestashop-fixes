from check_refund_overage_qty import find_refund_overage


def line(**over):
    base = {
        "id": 1,
        "id_order": 100,
        "product_id": 55,
        "product_quantity": 3,
        "product_quantity_refunded": 2,
        "product_quantity_return": 0,
        "product_quantity_reinjected": 0,
    }
    base.update(over)
    return base


def test_no_finding_when_refunded_within_ordered():
    assert find_refund_overage([line()]) == []


def test_flags_refunded_exceeding_ordered():
    findings = find_refund_overage([line(product_quantity=3, product_quantity_refunded=5)])
    assert len(findings) == 1
    finding = findings[0]
    assert finding["reason"] == "refunded_exceeds_ordered"
    assert finding["ordered"] == 3
    assert finding["refunded"] == 5
    assert finding["overage"] == 2


def test_flags_returned_exceeding_ordered():
    findings = find_refund_overage([line(product_quantity=2, product_quantity_return=4)])
    reasons = [f["reason"] for f in findings]
    assert "returned_exceeds_ordered" in reasons


def test_flags_reinjected_exceeding_refunded():
    findings = find_refund_overage([line(product_quantity_refunded=2, product_quantity_reinjected=3)])
    reasons = [f["reason"] for f in findings]
    assert "reinjected_exceeds_refunded" in reasons


def test_sorted_by_overage_descending():
    lines = [
        line(id=1, product_quantity=10, product_quantity_refunded=11),
        line(id=2, product_quantity=3, product_quantity_refunded=8),
    ]
    findings = find_refund_overage(lines)
    assert [f["id"] for f in findings] == [2, 1]


def test_equal_refunded_and_ordered_is_not_flagged():
    assert find_refund_overage([line(product_quantity=3, product_quantity_refunded=3)]) == []


def test_multiple_lines_only_flags_the_bad_one():
    lines = [line(id=1), line(id=2, product_quantity=1, product_quantity_refunded=4)]
    findings = find_refund_overage(lines)
    assert len(findings) == 1
    assert findings[0]["id"] == 2


def test_no_findings_for_empty_input():
    assert find_refund_overage([]) == []


def test_missing_optional_fields_default_to_zero():
    minimal = {
        "id": 9,
        "id_order": 200,
        "product_id": 7,
        "product_quantity": 5,
        "product_quantity_refunded": 5,
    }
    assert find_refund_overage([minimal]) == []
