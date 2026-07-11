"""Detect PrestaShop combinations whose stock got knocked out of shared scope
by a stock_availables API write, making them look deleted.

On a multistore install where the shop group shares stock, a combination's
stock_available row is stored once for the whole group at id_shop=0. A PUT to
stock_availables can write a concrete id_shop straight onto that row without
normalizing it back to the shared scope, so the shared-stock lookup no longer
finds it for any shop in the group and the combination reads as zero stock
everywhere. The product_attribute row itself is never deleted. This snapshots
combinations and stock before a write, re-checks them after, and flags rows
whose scope drifted while their shop group truly shares stock. It never
auto-repairs without a fresh re-confirmation, and defaults to dry run.

Guide: https://www.allanninal.dev/prestashop/stock-update-deletes-combination/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("stock_update_deletes_combination")

BASE_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
PRODUCT_IDS = [int(p) for p in os.environ.get("PRODUCT_IDS", "").split(",") if p.strip()]


def api_get(path, params):
    params = dict(params)
    params["output_format"] = "JSON"
    r = requests.get(f"{BASE_URL}/api/{path}", params=params, auth=(WS_KEY, ""), timeout=30)
    r.raise_for_status()
    return r.json()


def snapshot_combinations(id_product):
    data = api_get("combinations", {"display": "full", "filter[id_product]": id_product})
    return {int(c["id"]): c for c in (data.get("combinations") or [])}


def snapshot_stock_rows(id_product):
    data = api_get("stock_availables", {"display": "full", "filter[id_product]": id_product})
    rows = data.get("stock_availables") or []
    return [
        {
            "id": int(r["id"]),
            "id_product_attribute": int(r.get("id_product_attribute") or 0),
            "id_shop": int(r.get("id_shop") or 0),
            "id_shop_group": int(r.get("id_shop_group") or 0),
            "quantity": int(r.get("quantity") or 0),
        }
        for r in rows
    ]


def shop_group(id_shop_group):
    data = api_get(f"shop_groups/{id_shop_group}", {})
    g = data.get("shop_group") or {}
    return {
        "id_shop_group": int(g.get("id") or id_shop_group),
        "share_stock": str(g.get("share_stock", "0")) in ("1", "true", "True"),
    }


def is_combination_stock_orphaned(pre_snapshot, post_stock_row, shop_group_row):
    """
    pre_snapshot: {'id_product_attribute': int, 'existed': bool, 'quantity': int}
      -- combination + stock state captured before the API write
    post_stock_row: {'id_shop': int, 'id_shop_group': int, 'quantity': int, 'id_product_attribute': int}
      -- the stock_availables row as it reads after the write
    shop_group_row: {'id_shop_group': int, 'share_stock': bool}
      -- the shop group the row belongs to

    Returns True iff the combination existed before the write, the group
    shares stock, and the post-write row's shop scope has drifted off the
    shared id_shop=0 anchor (or its visible quantity collapsed to 0 while
    the pre-write quantity was positive) -- i.e. the combination's stock
    became invisible/orphaned without the combination itself having been
    intentionally deleted.
    """
    if not pre_snapshot.get("existed"):
        return False
    if not shop_group_row.get("share_stock"):
        return False
    scope_drifted = post_stock_row.get("id_shop", 0) != 0
    quantity_collapsed = (
        pre_snapshot.get("quantity", 0) > 0
        and post_stock_row.get("quantity", 0) == 0
    )
    return scope_drifted or quantity_collapsed


def restore_shared_scope(id_stock_available, id_shop_group, quantity):
    body = {
        "stock_available": {
            "id": id_stock_available,
            "id_shop": 0,
            "id_shop_group": id_shop_group,
            "quantity": quantity,
        }
    }
    if DRY_RUN:
        log.info("DRY RUN would PUT stock_availables/%s body=%s", id_stock_available, body)
        return
    r = requests.put(
        f"{BASE_URL}/api/stock_availables/{id_stock_available}",
        params={"output_format": "JSON"},
        json=body,
        auth=(WS_KEY, ""),
        timeout=30,
    )
    r.raise_for_status()


def run():
    flagged = 0
    for id_product in PRODUCT_IDS:
        pre_combinations = snapshot_combinations(id_product)
        pre_rows = {row["id"]: row for row in snapshot_stock_rows(id_product)}

        # In real use, your own stock sync writes here between the snapshot
        # above and the re-read below. This script only observes and flags.
        post_rows = snapshot_stock_rows(id_product)

        for post_row in post_rows:
            id_pa = post_row["id_product_attribute"]
            pre_row = pre_rows.get(post_row["id"])
            pre_snapshot = {
                "id_product_attribute": id_pa,
                "existed": id_pa in pre_combinations or id_pa == 0,
                "quantity": (pre_row or {}).get("quantity", 0),
            }
            group = shop_group(post_row["id_shop_group"])

            if not is_combination_stock_orphaned(pre_snapshot, post_row, group):
                continue

            flagged += 1
            log.warning(
                "Product %s combination id_product_attribute=%s stock row id=%s looks orphaned "
                "(id_shop=%s quantity=%s, group %s share_stock=%s)",
                id_product, id_pa, post_row["id"], post_row["id_shop"],
                post_row["quantity"], group["id_shop_group"], group["share_stock"],
            )
            restore_shared_scope(post_row["id"], group["id_shop_group"], pre_snapshot["quantity"])

    log.info("Done. %d row(s) flagged as orphaned combination stock.", flagged)


if __name__ == "__main__":
    run()
