"""Flag PrestaShop categories written via the webservice without shop scoping.

When a category is created or updated with a plain POST or PUT to /api/categories,
PrestaShop's ObjectModel::add()/update() associates it with every shop in the current
shop context unless the request explicitly narrows that with an id_shop query
parameter. The categories schema exposes id_shop_default, but that only marks the
shop used for display, it is not an association list (PrestaShop/PrestaShop issues
#13987 and #22918).

This script lists the shops in the install, pulls back categories in a given window,
and runs a pure decision function that flags any category whose resolved shop ids go
beyond what was expected. It reports by default. A corrective PUT that resends the
same category body scoped to a single id_shop is only sent when DRY_RUN=false and
--confirm is passed, one category id at a time.

Run on a schedule, or right after a sync job. Safe to run again and again.

Guide: https://www.allanninal.dev/prestashop/webservice-category-ignores-shop-scope/
"""
import os
import sys
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_category_shop_scope")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
PRESTASHOP_WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
EXPECTED_SHOP_IDS = {
    int(x) for x in os.environ.get("EXPECTED_SHOP_IDS", "1").split(",") if x.strip()
}
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def resolved_shop_ids(category):
    """Best-effort extraction of the shops a category is actually linked to.

    Prefers an explicit associations.shops list when the install exposes one.
    Falls back to id_shop_default, which is a display hint, not a true
    association list, but is the only signal the standard schema guarantees.
    """
    associations = (category.get("associations") or {}).get("shops")
    if associations:
        return {int(row["id"]) for row in associations}
    default = category.get("id_shop_default")
    return {int(default)} if default is not None else set()


def is_over_associated(category, expected_shop_ids, all_shop_ids):
    """Pure decision function, no I/O.

    category: plain dict with at least id_shop_default and, when available,
        associations.shops.
    expected_shop_ids: set[int] of shop ids the integration intended to use.
    all_shop_ids: set[int] of every shop id in the install.

    Returns True when the category's resolved shop ids are a superset of the
    expected set with extras, or when it is associated with every shop while
    the expected set is narrower than that.
    """
    associated = resolved_shop_ids(category)
    if not associated:
        return False
    over_expected = bool(associated - set(expected_shop_ids))
    all_shops_but_expected_narrower = (
        associated == set(all_shop_ids) and len(expected_shop_ids) < len(all_shop_ids)
    )
    return over_expected or all_shops_but_expected_narrower


def unintended_shop_ids(category, expected_shop_ids):
    """Companion function: the diff set for reporting. Pure, no I/O."""
    return resolved_shop_ids(category) - set(expected_shop_ids)


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def api_put(path, resource_key, body, params):
    r = requests.put(
        f"{PRESTASHOP_URL}/api/{path}",
        params=params, auth=AUTH,
        json={resource_key: body}, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def all_shop_ids():
    data = api_get("shops", params={"display": "full"})
    rows = data.get("shops") or []
    return {int(row["id"]) for row in rows}


def recent_categories(date_from):
    data = api_get("categories", params={
        "display": "full",
        "filter[date_add]": f"[{date_from},today]",
    })
    return data.get("categories") or []


def rescope_category_to_single_shop(category, id_shop):
    # Resend the identical body, only scoping the query string to id_shop and
    # updating id_shop_default. This is the documented pattern; there is no
    # dedicated association endpoint for categories.
    body = dict(category)
    body["id_shop_default"] = id_shop
    return api_put(
        f"categories/{category['id']}", "category", body,
        params={"output_format": "JSON", "id_shop": id_shop},
    )


def run(date_from="2000-01-01", confirm=False):
    shops = all_shop_ids()
    flagged = 0
    repaired = 0
    for category in recent_categories(date_from):
        if not is_over_associated(category, EXPECTED_SHOP_IDS, shops):
            continue
        flagged += 1
        extra = sorted(unintended_shop_ids(category, EXPECTED_SHOP_IDS))
        log.warning(
            "Category id=%s id_shop_default=%s unintended_shop_ids=%s",
            category.get("id"), category.get("id_shop_default"), extra,
        )
        if not DRY_RUN and confirm and len(EXPECTED_SHOP_IDS) == 1:
            target_shop = next(iter(EXPECTED_SHOP_IDS))
            rescope_category_to_single_shop(category, target_shop)
            repaired += 1
            log.info("Rescoped category id=%s to id_shop=%s.", category.get("id"), target_shop)
    log.info("Done. %d categorie(s) flagged, %d repaired.", flagged, repaired)


if __name__ == "__main__":
    run(confirm="--confirm" in sys.argv)
