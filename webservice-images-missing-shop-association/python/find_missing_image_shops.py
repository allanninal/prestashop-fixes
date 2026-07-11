"""Detect PrestaShop product images updated via webservice that never got their
per shop association written in ps_image_shop, in a multistore setup.

The webservice image entry point, WebserviceSpecificManagementImages, writes the
uploaded file and updates the image row on the PUT path (or a POST carrying
ps_method=PUT) used to update an existing image, but that path never calls the
shop association write, Image::addImageShop, for the id_shop the request body
carried. This is a confirmed, still-open core bug, PrestaShop/PrestaShop#35901,
reported on 8.0.3: the call returns HTTP 200 and the file is stored, but the
association always resolves to the default shop instead of the target shop.
Plain image creation via POST images/products/{id_product}/ does honor id_shop
correctly, so the defect is isolated to the update path.

This script reads each product's expected shops and images, probes whether each
(image, shop) pair actually resolves, and reports every missing triple. It never
resubmits the same PUT, since the bug is unconditional and retrying reproduces
the same silent no-op. Under DRY_RUN=true it only reports. The reviewed
workaround, only run with DRY_RUN=false, re-uploads the image as a new image
scoped to the missing shop, since creation is confirmed to honor id_shop, then
re-verifies it resolves before counting the product as repaired.

Guide: https://www.allanninal.dev/prestashop/webservice-images-missing-shop-association/

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_missing_image_shops")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
PRESTASHOP_WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def find_missing_image_shop_associations(product_images, product_shop_associations, image_shop_rows):
    """Pure decision function, no I/O.

    product_images: [{'id_product': int, 'id_image': int}, ...] from images/products/{id}?display=full
    product_shop_associations: [{'id_product': int, 'id_shop': int}, ...] from products/{id}?display=full associations.shops
    image_shop_rows: set of (id_image, id_shop) tuples known to exist (from ps_image_shop or per-shop probe)

    Returns list of (id_product, id_image, id_shop) triples that SHOULD have an association (because
    the product is linked to that shop) but don't, the exact set the repair step must act on.
    """
    expected_shops_by_product = {}
    for row in product_shop_associations:
        expected_shops_by_product.setdefault(row["id_product"], set()).add(row["id_shop"])

    missing = []
    for img in product_images:
        pid, iid = img["id_product"], img["id_image"]
        for shop in expected_shops_by_product.get(pid, set()):
            if (iid, shop) not in image_shop_rows:
                missing.append((pid, iid, shop))
    return missing


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def product_shop_ids(id_product):
    data = api_get(f"products/{id_product}", params={"display": "full"})
    shops = (data["product"].get("associations") or {}).get("shops") or {}
    return [int(s["id"]) for s in shops.get("shop", [])]


def product_image_ids(id_product):
    data = api_get(f"images/products/{id_product}", params={"display": "full"})
    images = data.get("image") or []
    if isinstance(images, dict):
        images = [images]
    return [int(img["id"]) for img in images]


def image_resolves_in_shop(id_product, id_image, id_shop):
    try:
        api_get(f"images/products/{id_product}/{id_image}", params={"id_shop": id_shop})
        return True
    except requests.HTTPError as e:
        if e.response is not None and e.response.status_code == 404:
            return False
        raise


def reupload_image_for_shop(id_product, id_shop, image_bytes, content_type="image/jpeg"):
    r = requests.post(
        f"{PRESTASHOP_URL}/api/images/products/{id_product}/",
        params={"id_shop": id_shop, "output_format": "JSON"},
        auth=AUTH,
        files={"image": ("image.jpg", image_bytes, content_type)},
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def collect_missing_triples(product_ids):
    product_images = []
    product_shop_associations = []
    image_shop_rows = set()

    for id_product in product_ids:
        shop_ids = product_shop_ids(id_product)
        for id_shop in shop_ids:
            product_shop_associations.append({"id_product": id_product, "id_shop": id_shop})

        image_ids = product_image_ids(id_product)
        for id_image in image_ids:
            product_images.append({"id_product": id_product, "id_image": id_image})
            for id_shop in shop_ids:
                if image_resolves_in_shop(id_product, id_image, id_shop):
                    image_shop_rows.add((id_image, id_shop))

    return find_missing_image_shop_associations(product_images, product_shop_associations, image_shop_rows)


def run(product_ids):
    missing = collect_missing_triples(product_ids)
    for id_product, id_image, id_shop in missing:
        log.warning("Product %s image %s missing association for shop %s. %s",
                    id_product, id_image, id_shop,
                    "would re-upload as a new shop image" if DRY_RUN else "re-uploading as a new shop image")
        if not DRY_RUN:
            log.error(
                "Re-upload requires the source image bytes, supply them via your own image "
                "loader and call reupload_image_for_shop(%s, %s, image_bytes) before re-verifying.",
                id_product, id_shop,
            )
    log.info("Done. %d missing association(s) found.", len(missing))


if __name__ == "__main__":
    target_product_ids = [int(p) for p in os.environ.get("PRODUCT_IDS", "").split(",") if p.strip()]
    run(target_product_ids)
