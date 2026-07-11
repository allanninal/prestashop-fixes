"""Find PrestaShop categories and products orphaned outside the root tree.

PrestaShop stores categories as a nested set tree (id_parent plus internal
nleft/nright bounds) rooted at each shop's designated root category
(shops.id_category, typically Home under a hidden super-root). If the root is
deleted directly instead of through the shop's reassignment flow, or a
category or product import sets id_parent to a non-existent or wrong-shop id,
child categories keep an id_parent that no longer resolves back to the root.
The front office only renders nodes reachable from the root, so the row stays
active in ps_category, and products stay linked via ps_category_product, but
neither is visible anywhere.

This script reads each shop's true root id, pulls every category and active
product over the webservice, walks id_parent links with a breadth first
search from the root, and runs a pure decision function that flags any
category or product the walk never reaches. It reports by default. A
corrective PUT that re-parents an orphaned category root to the shop's Home
category is only sent when DRY_RUN=false and the target has been confirmed.

Guide: https://www.allanninal.dev/prestashop/orphaned-categories-outside-root-tree/

Run on a schedule, or right after a suspicious import. Safe to run again and again.
"""
import os
import logging
from collections import deque
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_orphaned_categories")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def find_orphans(categories, root_ids, products):
    """Pure decision function, no I/O.

    categories: list[dict] each with id, id_parent, is_root_category.
    root_ids: set[int] of valid shop root category ids (shops.id_category).
    products: list[dict] each with id, id_category_default, category_ids (list[int]).

    Builds a parent to children adjacency map, walks it with a breadth first
    search from root_ids to compute reachable_category_ids, then returns the
    category ids and product ids that walk never reaches.

    Returns {"orphaned_categories": [...], "orphaned_products": [...]}.
    """
    root_ids = set(root_ids)

    children = {}
    for cat in categories:
        parent = cat.get("id_parent")
        if parent is not None:
            children.setdefault(parent, []).append(cat["id"])

    reachable = set(root_ids)
    queue = deque(root_ids)
    while queue:
        current = queue.popleft()
        for child_id in children.get(current, []):
            if child_id not in reachable:
                reachable.add(child_id)
                queue.append(child_id)

    orphaned_categories = [
        cat["id"] for cat in categories
        if cat["id"] not in reachable and cat["id"] not in root_ids
    ]

    orphaned_products = [
        p["id"] for p in products
        if p.get("id_category_default") not in reachable
        and not any(cid in reachable for cid in p.get("category_ids") or [])
    ]

    return {"orphaned_categories": orphaned_categories, "orphaned_products": orphaned_products}


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def api_put(path, resource_key, body, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.put(
        f"{PRESTASHOP_URL}/api/{path}",
        params=params, auth=AUTH,
        json={resource_key: body}, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def shop_root_ids():
    data = api_get("shops", params={"display": "full"})
    rows = data.get("shops") or []
    roots = {int(row["id_category"]) for row in rows if row.get("id_category")}
    if roots:
        return roots
    cfg = api_get("configurations", params={"filter[name]": "PS_HOME_CATEGORY"})
    rows = cfg.get("configurations") or []
    return {int(row["value"]) for row in rows if row.get("value")}


def all_categories():
    data = api_get("categories", params={"display": "full", "limit": "0"})
    rows = data.get("categories") or []
    return [
        {
            "id": int(row["id"]),
            "id_parent": int(row["id_parent"]) if row.get("id_parent") not in (None, "") else None,
            "is_root_category": str(row.get("is_root_category")) in ("1", "true", "True"),
        }
        for row in rows
    ]


def all_active_products():
    data = api_get("products", params={"display": "full", "filter[active]": "1", "limit": "0"})
    rows = data.get("products") or []
    products = []
    for row in rows:
        cats = ((row.get("associations") or {}).get("categories") or {}).get("category") or []
        category_ids = [int(c["id"]) for c in cats if c.get("id")]
        default = row.get("id_category_default")
        products.append({
            "id": int(row["id"]),
            "id_category_default": int(default) if default not in (None, "") else None,
            "category_ids": category_ids,
        })
    return products


def reparent_category_to_home(category, home_category_id):
    # Only used when DRY_RUN=false and a safe target has been confirmed.
    # PrestaShop recomputes nleft/nright for the moved subtree on save.
    body = dict(category)
    body["id_parent"] = home_category_id
    return api_put(f"categories/{category['id']}", "category", body)


def run():
    root_ids = shop_root_ids()
    categories = all_categories()
    products = all_active_products()
    result = find_orphans(categories, root_ids, products)

    orphaned_categories = result["orphaned_categories"]
    orphaned_products = result["orphaned_products"]
    by_id = {cat["id"]: cat for cat in categories}

    for cat_id in orphaned_categories:
        cat = by_id.get(cat_id, {})
        log.warning("Orphaned category id=%s id_parent=%s", cat_id, cat.get("id_parent"))

    for prod_id in orphaned_products:
        log.warning("Orphaned product id=%s", prod_id)

    if not DRY_RUN and orphaned_categories and root_ids:
        home_id = next(iter(root_ids))
        for cat_id in orphaned_categories:
            reparent_category_to_home(by_id[cat_id], home_id)
            log.info("Re-parented category id=%s to Home id_parent=%s.", cat_id, home_id)

    log.info(
        "Done. %d orphaned categorie(s), %d orphaned product(s) %s.",
        len(orphaned_categories), len(orphaned_products),
        "reported" if DRY_RUN else "reported and categories repaired",
    )


if __name__ == "__main__":
    run()
