"""Detect and safely repair PrestaShop products whose ps_image cover flag is
missing or duplicated, which breaks the storefront main image link.

ps_image enforces a unique key on (id_product, cover), so the database only
ever allows one row per product where cover = 1. But the webservice image
upload path, POST /api/images/products/{id}, never checks for an existing
cover before inserting a new image, so a second cover upload on a product
that already has one throws a duplicate key SQL error, tracked in
PrestaShop/PrestaShop#22803 and #23777. Separately, CSV import, product
duplication, and an interrupted API write can leave a product with zero
cover rows, since the cover flag is not copied or assigned automatically,
which breaks Image::getCover($id_product) on the storefront.

This script reads each product's images, classifies the cover state with a
pure function, and reports every product with zero or more than one cover.
Under DRY_RUN=true it only reports. The guarded repair path, only run with
DRY_RUN=false, demotes every extra cover but one or promotes a chosen image,
one PUT at a time, re-reading after each write to confirm the result before
moving to the next product.

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_cover_image")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
PRESTASHOP_WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def _truthy_cover(value):
    return value is True or value == "1" or value == 1


def classify_cover_state(images):
    """Pure decision function, no I/O.

    images: [{'id_image': int|str, 'cover': '0'|'1'|bool, 'position': int}, ...]

    Returns {'status': 'ok'|'no_cover'|'multi_cover'|'no_images', 'coverIds': [...], 'chosenCoverId': ...}

    1. Empty images -> no_images, nothing to fix.
    2. Exactly one truthy cover -> ok.
    3. Zero truthy covers -> no_cover, chosen is the lowest position (ties by lowest id_image).
    4. More than one truthy cover -> multi_cover, chosen is the lowest position among the
       cover-flagged images (ties by lowest id_image); the rest of coverIds should be demoted.
    """
    if not images:
        return {"status": "no_images", "coverIds": [], "chosenCoverId": None}

    cover_ids = [img["id_image"] for img in images if _truthy_cover(img.get("cover"))]

    if len(cover_ids) == 1:
        return {"status": "ok", "coverIds": cover_ids, "chosenCoverId": cover_ids[0]}

    def sort_key(img):
        return (img.get("position", 0), img["id_image"])

    if len(cover_ids) == 0:
        chosen = sorted(images, key=sort_key)[0]["id_image"]
        return {"status": "no_cover", "coverIds": [], "chosenCoverId": chosen}

    cover_images = [img for img in images if img["id_image"] in cover_ids]
    chosen = sorted(cover_images, key=sort_key)[0]["id_image"]
    return {"status": "multi_cover", "coverIds": cover_ids, "chosenCoverId": chosen}


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def api_put_cover(id_product, id_image, cover_value):
    r = requests.put(
        f"{PRESTASHOP_URL}/api/images/products/{id_product}/{id_image}",
        params={"output_format": "JSON"},
        auth=AUTH,
        json={"image": {"id": id_image, "cover": cover_value}},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def active_product_ids(limit="0,100"):
    data = api_get("products", params={"display": "full", "filter[active]": "1", "limit": limit})
    products = data.get("products") or []
    if isinstance(products, dict):
        products = [products]
    return [int(p["id"]) for p in products]


def product_image_ids(id_product):
    data = api_get(f"images/products/{id_product}")
    images = data.get("image") or []
    if isinstance(images, dict):
        images = [images]
    return [int(img["id"]) for img in images]


def fetch_image_record(id_product, id_image):
    data = api_get(f"images/products/{id_product}/{id_image}")
    img = data.get("image") or {}
    return {
        "id_image": int(img.get("id", id_image)),
        "cover": img.get("cover"),
        "position": int(img.get("position", 0)),
    }


def fetch_product_images(id_product):
    return [fetch_image_record(id_product, iid) for iid in product_image_ids(id_product)]


def report_product(id_product, classification):
    if classification["status"] in ("ok", "no_images"):
        return
    log.warning(
        "Product %s status=%s coverIds=%s suggestedCoverId=%s",
        id_product, classification["status"], classification["coverIds"], classification["chosenCoverId"],
    )


def repair_product(id_product, classification):
    status = classification["status"]
    chosen = classification["chosenCoverId"]

    if status == "multi_cover":
        for id_image in classification["coverIds"]:
            if id_image == chosen:
                continue
            api_put_cover(id_product, id_image, "0")
            confirmed = fetch_image_record(id_product, id_image)
            if _truthy_cover(confirmed.get("cover")):
                raise RuntimeError(
                    f"Product {id_product} image {id_image} still cover after demote, stopping"
                )
        api_put_cover(id_product, chosen, "1")
        confirmed = fetch_image_record(id_product, chosen)
        if not _truthy_cover(confirmed.get("cover")):
            raise RuntimeError(f"Product {id_product} chosen cover {chosen} did not confirm, stopping")

    elif status == "no_cover":
        api_put_cover(id_product, chosen, "1")
        confirmed = fetch_image_record(id_product, chosen)
        if not _truthy_cover(confirmed.get("cover")):
            raise RuntimeError(f"Product {id_product} chosen cover {chosen} did not confirm, stopping")


def run(product_ids):
    broken = 0
    for id_product in product_ids:
        images = fetch_product_images(id_product)
        classification = classify_cover_state(images)
        if classification["status"] in ("ok", "no_images"):
            continue
        broken += 1
        report_product(id_product, classification)
        if not DRY_RUN:
            log.info("Repairing product %s (%s)", id_product, classification["status"])
            repair_product(id_product, classification)
    log.info("Done. %d product(s) with a broken cover %s.", broken, "found" if DRY_RUN else "repaired")


if __name__ == "__main__":
    target_product_ids = [int(p) for p in os.environ.get("PRODUCT_IDS", "").split(",") if p.strip()]
    run(target_product_ids)
