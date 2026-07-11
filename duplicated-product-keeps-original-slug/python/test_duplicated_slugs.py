from fix_duplicated_product_slug import suffix_duplicate_slugs, names_diverged


def product(**over):
    base = {"id": 1, "link_rewrite": "desktop-computer", "name": "Desktop Computer", "date_add": "2026-01-01 00:00:00"}
    base.update(over)
    return base


def test_no_changes_when_all_slugs_unique():
    rows = [
        product(id=1, link_rewrite="desktop-computer"),
        product(id=2, link_rewrite="laptop-computer"),
    ]
    assert suffix_duplicate_slugs(rows, 1) == []


def test_duplicate_keeps_earliest_and_suffixes_the_rest():
    rows = [
        product(id=1, link_rewrite="desktop-computer", date_add="2026-01-01 00:00:00"),
        product(id=7, link_rewrite="desktop-computer", date_add="2026-02-15 00:00:00"),
    ]
    changes = suffix_duplicate_slugs(rows, 1)
    assert changes == [{"id": 7, "old_slug": "desktop-computer", "new_slug": "desktop-computer-7"}]


def test_falls_back_to_id_when_date_add_ties():
    rows = [
        product(id=5, link_rewrite="desktop-computer", date_add="2026-01-01 00:00:00"),
        product(id=2, link_rewrite="desktop-computer", date_add="2026-01-01 00:00:00"),
    ]
    changes = suffix_duplicate_slugs(rows, 1)
    assert changes == [{"id": 5, "old_slug": "desktop-computer", "new_slug": "desktop-computer-5"}]


def test_appends_dup_when_suffixed_candidate_already_taken():
    rows = [
        product(id=1, link_rewrite="desktop-computer", date_add="2026-01-01 00:00:00"),
        product(id=9, link_rewrite="desktop-computer", date_add="2026-02-01 00:00:00"),
        product(id=99, link_rewrite="desktop-computer-9", date_add="2026-01-05 00:00:00"),
    ]
    changes = suffix_duplicate_slugs(rows, 1)
    assert {"id": 9, "old_slug": "desktop-computer", "new_slug": "desktop-computer-9-dup"} in changes


def test_three_way_collision_keeps_earliest_and_suffixes_the_rest():
    rows = [
        product(id=3, link_rewrite="office-chair", date_add="2026-03-01 00:00:00"),
        product(id=1, link_rewrite="office-chair", date_add="2026-01-01 00:00:00"),
        product(id=2, link_rewrite="office-chair", date_add="2026-02-01 00:00:00"),
    ]
    changes = suffix_duplicate_slugs(rows, 1)
    assert sorted(c["id"] for c in changes) == [2, 3]


def test_names_diverged_true_when_unrelated():
    assert names_diverged("Desktop Computer", "Garden Hose") is True


def test_names_diverged_false_when_still_similar():
    assert names_diverged("Desktop Computer", "Desktop Computer V2") is False


def test_names_diverged_true_when_either_name_missing():
    assert names_diverged("", "Desktop Computer") is True
    assert names_diverged("Desktop Computer", "") is True
