from find_missing_image_shops import find_missing_image_shop_associations


def test_no_missing_when_every_shop_has_a_row():
    product_images = [{"id_product": 10, "id_image": 100}]
    product_shop_associations = [{"id_product": 10, "id_shop": 1}, {"id_product": 10, "id_shop": 2}]
    image_shop_rows = {(100, 1), (100, 2)}
    result = find_missing_image_shop_associations(product_images, product_shop_associations, image_shop_rows)
    assert result == []


def test_flags_missing_second_shop():
    product_images = [{"id_product": 10, "id_image": 100}]
    product_shop_associations = [{"id_product": 10, "id_shop": 1}, {"id_product": 10, "id_shop": 2}]
    image_shop_rows = {(100, 1)}
    result = find_missing_image_shop_associations(product_images, product_shop_associations, image_shop_rows)
    assert result == [(10, 100, 2)]


def test_multiple_images_and_shops():
    product_images = [{"id_product": 10, "id_image": 100}, {"id_product": 10, "id_image": 101}]
    product_shop_associations = [{"id_product": 10, "id_shop": 1}, {"id_product": 10, "id_shop": 2}]
    image_shop_rows = {(100, 1), (100, 2), (101, 1)}
    result = find_missing_image_shop_associations(product_images, product_shop_associations, image_shop_rows)
    assert result == [(10, 101, 2)]


def test_no_expected_shops_means_nothing_missing():
    product_images = [{"id_product": 10, "id_image": 100}]
    product_shop_associations = []
    image_shop_rows = set()
    result = find_missing_image_shop_associations(product_images, product_shop_associations, image_shop_rows)
    assert result == []


def test_image_with_no_rows_at_all_flags_every_expected_shop():
    product_images = [{"id_product": 10, "id_image": 100}]
    product_shop_associations = [{"id_product": 10, "id_shop": 1}, {"id_product": 10, "id_shop": 3}]
    image_shop_rows = set()
    result = find_missing_image_shop_associations(product_images, product_shop_associations, image_shop_rows)
    assert sorted(result) == [(10, 100, 1), (10, 100, 3)]


def test_ignores_shops_not_expected_by_the_product():
    product_images = [{"id_product": 10, "id_image": 100}]
    product_shop_associations = [{"id_product": 10, "id_shop": 1}]
    image_shop_rows = {(100, 9)}
    result = find_missing_image_shop_associations(product_images, product_shop_associations, image_shop_rows)
    assert result == [(10, 100, 1)]


def test_different_products_are_kept_separate():
    product_images = [{"id_product": 10, "id_image": 100}, {"id_product": 20, "id_image": 200}]
    product_shop_associations = [{"id_product": 10, "id_shop": 1}, {"id_product": 20, "id_shop": 1}]
    image_shop_rows = {(100, 1)}
    result = find_missing_image_shop_associations(product_images, product_shop_associations, image_shop_rows)
    assert result == [(20, 200, 1)]
