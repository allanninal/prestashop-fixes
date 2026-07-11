"""Find and safely fix PrestaShop products whose friendly URL was copied
verbatim from the product they were duplicated from.

PrestaShop's Duplicate action, backed by ObjectModel::duplicateObject() and
Product::duplicate(), clones the source product's rows with a raw
INSERT ... SELECT copy, including every ps_product_lang row, then only
rewrites id_product and a few flags such as active. The friendly URL slug in
link_rewrite is only ever regenerated from the product name inside
AdminProductsController's form-save path, using Tools::link_rewrite() or
str2url(), triggered when the Name field is actually edited and saved. The
duplication flow never runs that path, so the clone keeps the identical
link_rewrite as the original in every language. Because the product URL is
unique on id_product plus link_rewrite together, not on link_rewrite alone,
no SQL error is raised: both products stay reachable, and the collision only
shows up as visually identical URLs, canonical confusion, and duplicate
content signals to search engines.

This script detects every collision, keeps the earliest product in each
group (by date_add) as the canonical original, and proposes a deterministic
new slug for every later duplicate. It skips any duplicate whose name has
diverged significantly from the original, since that usually means a human
already turned the copy into its own product and just never touched its
slug, a case that should be flagged for a human to rename from the SEO tab
instead of guessed automatically. Writing is guarded by DRY_RUN, which
defaults to true, since a rename changes a public URL.

Run after any bulk duplication session, or on a nightly schedule. Safe to
run again and again: an already-renamed slug will not collide a second time.

Guide: https://www.allanninal.dev/prestashop/duplicated-product-keeps-original-slug/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_duplicated_product_slug")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")


def suffix_duplicate_slugs(products, id_lang):
    """Pure decision function, no I/O.

    products is a list of {"id": int, "link_rewrite": str, "name": str,
    "date_add": str} already resolved to a single language (id_lang is kept
    only for readability/logging at the call site). Groups records by
    link_rewrite; any group with more than one member is a collision. The
    earliest member by date_add (falling back to id) is kept unchanged, and
    every other member gets new_slug = f"{old_slug}-{id}", extended with a
    "-dup" suffix if that candidate still collides with any other slug
    already present in the full product set, including another group's own
    repair. Returns only the changed entries.
    """
    groups = {}
    for p in products:
        groups.setdefault(p["link_rewrite"], []).append(p)

    all_slugs = {p["link_rewrite"] for p in products}
    changes = []
    for slug, members in groups.items():
        if len(members) < 2:
            continue
        ordered = sorted(members, key=lambda p: (p["date_add"] or "", p["id"]))
        for p in ordered[1:]:
            candidate = f"{slug}-{p['id']}"
            while candidate in all_slugs:
                candidate = f"{candidate}-dup"
            all_slugs.add(candidate)
            changes.append({"id": p["id"], "old_slug": slug, "new_slug": candidate})
    return changes


def names_diverged(original_name, duplicate_name):
    """True when the duplicate's name no longer resembles the original's,
    meaning the slug should only be flagged for a human, never auto-fixed."""
    a = (original_name or "").strip().lower()
    b = (duplicate_name or "").strip().lower()
    if not a or not b:
        return True
    return a not in b and b not in a


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def _entries(value):
    if isinstance(value, dict):
        return [value]
    return value or []


def _lang_id(entry):
    lang = entry.get("language") or {}
    attrs = lang.get("@attributes") or lang
    return int(attrs.get("id", 1))


def all_products():
    data = api_get("products", params={
        "display": "[id,id_default_image,link_rewrite,name,date_add]",
        "limit": "0",
    })
    return data.get("products") or []


def flatten_by_lang(raw_products):
    """Returns {id_lang: [{"id": int, "link_rewrite": str, "name": str, "date_add": str}, ...]}"""
    by_lang = {}
    for item in raw_products:
        slug_entries = {_lang_id(e): e.get("#text", "") for e in _entries(item.get("link_rewrite"))}
        name_entries = {_lang_id(e): e.get("#text", "") for e in _entries(item.get("name"))}
        for id_lang, slug in slug_entries.items():
            by_lang.setdefault(id_lang, []).append({
                "id": int(item["id"]),
                "link_rewrite": slug,
                "name": name_entries.get(id_lang, ""),
                "date_add": item.get("date_add", ""),
            })
    return by_lang


def apply_rename(product_id, new_slug, id_lang):
    full = api_get(f"products/{product_id}")
    node = full["product"]
    entries = node["link_rewrite"]
    if isinstance(entries, dict):
        entries = [entries]
    for entry in entries:
        lang = entry.get("language") or {}
        attrs = lang.get("@attributes") or lang
        if int(attrs.get("id", 1)) == id_lang:
            entry["#text"] = new_slug
    node["link_rewrite"] = entries
    r = requests.put(
        f"{PRESTASHOP_URL}/api/products/{product_id}",
        params={"output_format": "JSON"},
        json=full,
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()


def run():
    raw_products = all_products()
    by_lang = flatten_by_lang(raw_products)

    fixed = 0
    flagged = 0
    for id_lang, products in by_lang.items():
        by_product_id = {p["id"]: p for p in products}
        changes = suffix_duplicate_slugs(products, id_lang)
        for change in changes:
            dup = by_product_id[change["id"]]
            original_group = [p for p in products if p["link_rewrite"] == change["old_slug"]]
            original = min(original_group, key=lambda p: (p["date_add"] or "", p["id"]))
            if names_diverged(original["name"], dup["name"]):
                log.warning(
                    "id_lang=%s id=%s old_slug=%s name=%r diverged from original name=%r. Flagging for a human.",
                    id_lang, change["id"], change["old_slug"], dup["name"], original["name"],
                )
                flagged += 1
                continue
            log.warning(
                "id_lang=%s id=%s old_slug=%s %s new_slug=%s",
                id_lang, change["id"], change["old_slug"],
                "would rename to" if DRY_RUN else "renaming to", change["new_slug"],
            )
            if not DRY_RUN:
                apply_rename(change["id"], change["new_slug"], id_lang)
            fixed += 1
    log.info(
        "Done. %d slug(s) %s, %d flagged for a human. DRY_RUN=%s.",
        fixed, "to rename" if DRY_RUN else "renamed", flagged, DRY_RUN,
    )


if __name__ == "__main__":
    run()
