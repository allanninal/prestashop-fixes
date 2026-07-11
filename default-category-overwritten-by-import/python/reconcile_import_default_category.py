"""Catch and safely repair a PrestaShop product default category overwritten by import.

PrestaShop's product CSV importer (AdminImportController) builds each row
independently from the Category column. When multiple category ids or names
are comma separated it has historically picked the first one in the list, or
in older "Force ID" flows silently reset id_category_default to whatever the
file's ordering implies, rather than preserving the product's prior default
(PrestaShop/PrestaShop issues #27938 and #10871). A partial update file that
omits the category column can cause the same overwrite (issue #32412). In
multistore, the default category is scoped per shop, so an import run without
shop scoping can overwrite the wrong shop's default.

This script snapshots every affected product's id_category_default before an
import, re-reads the same products after, and runs a pure decision function
that classifies each product as unchanged, needing manual review (flag), or a
safe automatic repair candidate (the classic "reset to Home" signature). A
restoring PUT is only sent when DRY_RUN=false, scoped per shop, and only for
the repair action. Ambiguous changes and dropped associations are always
flagged, never auto-written.

Guide: https://www.allanninal.dev/prestashop/default-category-overwritten-by-import/

Run right before and right after a catalog import. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_import_default_category")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
ROOT_CATEGORY_ID = int(os.environ.get("ROOT_CATEGORY_ID", "2"))
AUTH = (PRESTASHOP_WS_KEY, "")


def decide_category_repair(product_id, id_shop, pre_import_default, post_import_default,
                            post_import_category_ids, root_category_id=2):
    """Pure decision function, no I/O.

    product_id: int, the product being checked.
    id_shop: int | None, the shop context, or None for a single-shop install.
    pre_import_default: int, id_category_default read before the import.
    post_import_default: int, id_category_default read after the import.
    post_import_category_ids: list[int], associations.categories.category[].id
        read after the import.
    root_category_id: int, the store's root/Home category id, default 2.

    Returns a dict {product_id, id_shop, action, reason, restore_to}. action is
    one of "none", "flag", "repair". restore_to is the pre_import_default when
    a repair or a flagged-for-confirmation change is proposed, otherwise None.

    Logic:
      - post_import_default == pre_import_default -> action="none".
      - pre_import_default not in post_import_category_ids -> action="flag"
        (the default category link itself was lost, needs manual review;
        it is not safe to restore an association that is gone too).
      - post_import_default == root_category_id and pre_import_default is not
        -> action="repair", restore_to=pre_import_default (classic "reset to
        Home" corruption signature).
      - otherwise -> action="flag", restore_to=pre_import_default (ambiguous
        change, surface for human confirmation rather than blind overwrite).
    """
    post_ids = [int(x) for x in (post_import_category_ids or [])]
    pre_default = int(pre_import_default)
    post_default = int(post_import_default)
    root = int(root_category_id)

    if post_default == pre_default:
        return {
            "product_id": product_id, "id_shop": id_shop, "action": "none",
            "reason": "default unchanged", "restore_to": None,
        }

    if pre_default not in post_ids:
        return {
            "product_id": product_id, "id_shop": id_shop, "action": "flag",
            "reason": "prior default is no longer in associations, needs manual review",
            "restore_to": None,
        }

    if post_default == root and pre_default != root:
        return {
            "product_id": product_id, "id_shop": id_shop, "action": "repair",
            "reason": "reset to Home/root category, classic import corruption",
            "restore_to": pre_default,
        }

    return {
        "product_id": product_id, "id_shop": id_shop, "action": "flag",
        "reason": "ambiguous change, surface for human confirmation",
        "restore_to": pre_default,
    }


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


def category_ids_of(row):
    categories = ((row.get("associations") or {}).get("categories") or {}).get("category") or []
    return [int(c["id"]) for c in categories]


def read_product_state(product_id, id_shop=None):
    """Read id_category_default and associated category ids for one product."""
    params = {
        "filter[id]": product_id,
        "display": "[id,id_category_default,associations.categories]",
    }
    if id_shop is not None:
        params["id_shop"] = id_shop
    rows = api_get("products", params=params).get("products") or []
    if not rows:
        return None
    row = rows[0]
    return {
        "id_category_default": int(row["id_category_default"]),
        "category_ids": category_ids_of(row),
    }


def snapshot(product_ids, shop_ids=None):
    """Read id_category_default for every (product_id, id_shop) pair before an import."""
    result = {}
    for pid in product_ids:
        for sid in (shop_ids or [None]):
            state = read_product_state(pid, id_shop=sid)
            if state is not None:
                result[(pid, sid)] = state["id_category_default"]
    return result


def restore_default_category(product_id, id_shop, restore_to):
    """Fetch-modify-PUT the product, resetting only id_category_default.

    Adds the category id back into associations.categories if it was dropped,
    so the default is never left pointing outside the product's own
    associations. Scoped to id_shop when provided, so a multistore repair
    never touches the "all shops" context.
    """
    params = {"id_shop": id_shop} if id_shop is not None else None
    current = api_get(f"products/{product_id}", params=params)["product"]
    body = dict(current)
    body["id_category_default"] = restore_to
    categories = ((body.get("associations") or {}).get("categories") or {}).get("category") or []
    ids = {int(c["id"]) for c in categories}
    if restore_to not in ids:
        categories.append({"id": restore_to})
        body.setdefault("associations", {}).setdefault("categories", {})["category"] = categories
    return api_put(f"products/{product_id}", "product", body, params=params)


def reconcile(pre_snapshot, product_ids, shop_ids=None):
    """Compare the pre-import snapshot to the current state and act per decision."""
    flagged = 0
    repaired = 0
    for pid in product_ids:
        for sid in (shop_ids or [None]):
            pre_default = pre_snapshot.get((pid, sid))
            if pre_default is None:
                log.info("Skipping product %s (shop %s): no pre-import snapshot.", pid, sid)
                continue
            post_state = read_product_state(pid, id_shop=sid)
            if post_state is None:
                log.warning("Skipping product %s (shop %s): not found after import.", pid, sid)
                continue
            decision = decide_category_repair(
                pid, sid, pre_default, post_state["id_category_default"],
                post_state["category_ids"], ROOT_CATEGORY_ID,
            )
            if decision["action"] == "none":
                continue
            if decision["action"] == "flag":
                flagged += 1
                log.warning(
                    "FLAG product=%s shop=%s: %s (pre=%s post=%s)",
                    pid, sid, decision["reason"], pre_default, post_state["id_category_default"],
                )
                continue
            # action == "repair"
            log.warning(
                "REPAIR candidate product=%s shop=%s: %s (pre=%s post=%s)",
                pid, sid, decision["reason"], pre_default, post_state["id_category_default"],
            )
            if not DRY_RUN:
                restore_default_category(pid, sid, decision["restore_to"])
                repaired += 1
                log.info("Repaired product=%s shop=%s: restored id_category_default=%s.",
                          pid, sid, decision["restore_to"])
    log.info("Done. %d flagged for review, %d repaired.", flagged, repaired)


def run(product_ids, shop_ids=None):
    """Take and return the pre-import snapshot. Persist it yourself, run your
    import, then call reconcile(saved_snapshot, product_ids, shop_ids) after."""
    pre_snapshot = snapshot(product_ids, shop_ids=shop_ids)
    log.info("Snapshotted %d product/shop pair(s) before import.", len(pre_snapshot))
    return pre_snapshot


if __name__ == "__main__":
    ids = [int(x) for x in os.environ.get("PRODUCT_IDS", "").split(",") if x.strip()]
    if not ids:
        log.info("Set PRODUCT_IDS to a comma separated list of product ids to check.")
    else:
        snap = run(ids)
        reconcile(snap, ids)
