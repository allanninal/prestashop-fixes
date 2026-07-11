"""Find, and only on explicit confirmation rewrite, duplicate PrestaShop
product references or SKUs across different products.

ps_product.reference has no unique, or even indexed-unique, database
constraint. The back office product form, the Duplicate product action, and
the Webservice API layer never check other rows before INSERT/UPDATE, so two
different id_product rows can carry the identical reference string
indefinitely. This is a known, unaddressed gap tracked on PrestaShop's own
bug tracker (GitHub #13413).

This script pulls the catalog through the Webservice API, groups products by
a normalized (trimmed) reference, skips blank references since PrestaShop
allows and commonly has many, and reports every reference used by more than
one product id. It optionally cross-checks combinations, since PrestaShop
does not enforce uniqueness there either. By default it only reports. Set
DRY_RUN=false and supply RESOLUTION_MAP (a JSON object of {"id": "new
reference"}) to let it PUT a renamed reference for the ids you name. It never
renames a product you did not name, never merges, and never deletes.

Guide: https://www.allanninal.dev/prestashop/duplicate-product-reference-sku/
"""
import os
import json
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_reference_collisions")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
RESOLUTION_MAP = json.loads(os.environ.get("RESOLUTION_MAP", "{}"))


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(
        f"{PRESTASHOP_URL}/api/{path}",
        params=params,
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def api_put(path, body):
    r = requests.put(
        f"{PRESTASHOP_URL}/api/{path}",
        params={"output_format": "JSON"},
        json=body,
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def find_reference_collisions(products):
    """products: list of {"id": int, "reference": str, "name": str, "active": bool}
    as returned by GET /api/products?display=[id,reference,name,active].

    Decision logic (no I/O):
      1. Normalize reference by stripping whitespace; skip entries whose
         normalized reference is "" (blank references are not collisions --
         PrestaShop allows and commonly has many blank references).
      2. Group remaining products by normalized reference.
      3. Keep only groups where len(group) > 1 -- i.e. the same reference
         string is attached to 2+ distinct product ids.
      4. Return a dict mapping reference -> list of the colliding product
         dicts (id, name, active), sorted by id, for every collision found.
         Empty dict means no collisions.

    This mirrors why the collision exists in PrestaShop: ps_product.reference
    has no UNIQUE/DB constraint and the admin/back-office and duplicate-product
    action never check other rows before INSERT/UPDATE, so two different
    id_product rows can carry an identical reference string indefinitely.
    """
    groups = {}
    for product in products:
        ref = (product.get("reference") or "").strip()
        if not ref:
            continue
        groups.setdefault(ref, []).append(product)

    collisions = {}
    for ref, group in groups.items():
        if len(group) <= 1:
            continue
        collisions[ref] = sorted(group, key=lambda p: int(p["id"]))
    return collisions


def find_combination_reference_collisions(combinations):
    """Apply the same grouping/collision logic to combinations, since
    combination-level references can collide across products too, and
    PrestaShop does not enforce uniqueness there either. Pure: no I/O.
    """
    normalized = [
        {"id": c["id"], "reference": c.get("reference"), "name": f"product {c['id_product']}", "active": True}
        for c in combinations
    ]
    return find_reference_collisions(normalized)


def all_products():
    data = api_get("products", {
        "display": "[id,reference,name,active]",
        "limit": "0",
    })
    return data.get("products") or []


def all_combinations():
    data = api_get("combinations", {
        "display": "[id,id_product,reference]",
    })
    return data.get("combinations") or []


def apply_resolution(id_product, new_reference):
    """Fetch the current full product body, change only reference, and PUT
    the complete resource back (PrestaShop's webservice PUT requires the full
    body, not a partial patch). Only ever called for ids named in
    RESOLUTION_MAP by the operator, and only writes when DRY_RUN is false.
    """
    current = api_get(f"products/{id_product}")["product"]
    current["reference"] = new_reference
    log.info("Renaming product %s reference to %s", id_product, new_reference)
    if not DRY_RUN:
        api_put(f"products/{id_product}", {"product": current})


def run():
    products = all_products()
    combinations = all_combinations()

    product_collisions = find_reference_collisions(products)
    combo_collisions = find_combination_reference_collisions(combinations)

    for ref, group in product_collisions.items():
        print(json.dumps({
            "reference": ref,
            "colliding_ids": [p["id"] for p in group],
            "names": [p["name"] for p in group],
        }))

    for ref, group in combo_collisions.items():
        print(json.dumps({
            "combination_reference": ref,
            "colliding_ids": [c["id"] for c in group],
            "products": [c["name"] for c in group],
        }))

    if not DRY_RUN and RESOLUTION_MAP:
        for id_product, new_reference in RESOLUTION_MAP.items():
            apply_resolution(id_product, new_reference)

    log.info(
        "Done. %d product reference collision(s), %d combination reference collision(s).",
        len(product_collisions), len(combo_collisions),
    )


if __name__ == "__main__":
    run()
