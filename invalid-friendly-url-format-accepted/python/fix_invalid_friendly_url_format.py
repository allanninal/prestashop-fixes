"""Find and safely repair PrestaShop link_rewrite values that are not a valid slug.

PrestaShop's webservice layer validates most product fields strictly, but it does
not consistently run link_rewrite through Validate::isLinkRewrite() on every write
path. Reported bugs, such as GitHub issue #13151, show the API accepting a value
like "abc.com" on product creation, because validation runs inconsistently across
POST and PUT versus the back-office ObjectModel::validateFields() flow, and the
row only starts failing when it is re-saved through the admin form. Separately,
Tools::str2url(), meant to slugify a free-text title into a safe link_rewrite, has
in some PS8 releases stopped stripping every disallowed character (GitHub issue
#38161), so a caller that skips slugification and posts a raw title, a full URL,
or Unicode punctuation can land it directly in the link_rewrite column. Because
.htaccess rewrite rules and the SEO URL resolver assume link_rewrite is a clean
slug, a stored value containing dots, slashes, spaces, or scheme-like text breaks
canonical URL generation and can 404 the page even though the row saved fine.

This script pulls every product, category, manufacturer, and CMS page
link_rewrite per language through the webservice, tests each value against the
same regex PrestaShop itself enforces (Validate::isLinkRewrite(), widened for
accented characters when PS_ALLOW_ACCENTED_CHARS_URL is on), and reports every
value that fails. Repairing is guarded by DRY_RUN, which defaults to true, since
a repair changes a public URL. Turn on PrestaShop's own 301 redirect preference
for changed product URLs before running with DRY_RUN=false.

Run on a schedule, or right after any bulk import or webservice write job. Safe
to run again and again: an already-valid slug is never touched.

Guide: https://www.allanninal.dev/prestashop/invalid-friendly-url-format-accepted/
"""
import os
import re
import logging
import unicodedata
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_invalid_friendly_url_format")

PRESTASHOP_URL = os.environ.get("PRESTASHOP_URL", "https://demo.example.com").rstrip("/")
PRESTASHOP_WS_KEY = os.environ.get("PRESTASHOP_WS_KEY", "WSKEYDUMMY")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")

RESOURCES = ["products", "categories", "manufacturers", "content_management_system"]

_PLAIN = re.compile(r"^[_a-zA-Z0-9\-]+$")
_ACCENTED = re.compile(r"^[_a-zA-Z0-9\-\w]+$", re.UNICODE)
_DISALLOWED_CHARS = (" ", ".", "/", ":", "\\")


def is_valid_slug(value, allow_accented=False):
    """Pure decision function, no I/O.

    Mirrors PrestaShop's own Validate::isLinkRewrite(): letters, digits,
    underscores, and hyphens only, or that same set plus accented word
    characters when allow_accented is True. Additionally rejects empty
    strings and any value containing a space, dot, slash, colon, or
    backslash even when the base regex would otherwise admit it, since
    none of those characters belong in a slug.
    """
    if not value or any(c in value for c in _DISALLOWED_CHARS):
        return False
    pattern = _ACCENTED if allow_accented else _PLAIN
    return bool(pattern.match(value))


def slugify(name):
    normalized = unicodedata.normalize("NFKD", name or "")
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    lowered = ascii_only.lower()
    slug = re.sub(r"[^a-z0-9_-]+", "-", lowered).strip("-")
    return slug or "untitled"


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def api_put(path, body):
    r = requests.put(
        f"{PRESTASHOP_URL}/api/{path}",
        params={"output_format": "JSON"},
        json=body,
        auth=AUTH,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def accented_urls_allowed():
    data = api_get("configurations", params={"filter[name]": "PS_ALLOW_ACCENTED_CHARS_URL"})
    rows = data.get("configurations") or []
    if not rows:
        return False
    return str(rows[0].get("value", "0")) == "1"


def _by_lang(entries):
    if isinstance(entries, dict):
        entries = [entries]
    out = {}
    for entry in entries or []:
        lang = entry.get("language") or {}
        id_lang = int(lang.get("@id", lang.get("id", 1)))
        out[id_lang] = entry.get("value", entry.get("#text", ""))
    return out


def flatten_resource(resource, raw_items):
    records = []
    for item in raw_items:
        slugs = _by_lang(item.get("link_rewrite"))
        names = _by_lang(item.get("name") or item.get("meta_title"))
        for id_lang, slug in slugs.items():
            records.append({
                "resource": resource,
                "id": int(item["id"]),
                "id_lang": id_lang,
                "link_rewrite": slug,
                "name": names.get(id_lang, ""),
            })
    return records


def collect_records():
    all_records = []
    for resource in RESOURCES:
        data = api_get(resource, params={"display": "full", "limit": "0"})
        raw_items = data.get(resource) or []
        all_records.extend(flatten_resource(resource, raw_items))
    return all_records


def apply_repair(record, candidate):
    resource = record["resource"]
    full = api_get(f"{resource}/{record['id']}")
    singular = resource[:-1] if resource != "content_management_system" else "content_management_system"
    node = full[singular]
    entries = node["link_rewrite"]
    if isinstance(entries, dict):
        entries = [entries]
    for entry in entries:
        lang = entry.get("language") or {}
        if int(lang.get("@id", lang.get("id", 1))) == record["id_lang"]:
            entry["value"] = candidate
    node["link_rewrite"] = entries
    api_put(f"{resource}/{record['id']}", full)

    confirm = api_get(f"{resource}/{record['id']}")
    confirm_entries = confirm[singular]["link_rewrite"]
    if isinstance(confirm_entries, dict):
        confirm_entries = [confirm_entries]
    for entry in confirm_entries:
        lang = entry.get("language") or {}
        if int(lang.get("@id", lang.get("id", 1))) == record["id_lang"]:
            stored = entry.get("value", entry.get("#text", ""))
            if stored != candidate:
                raise RuntimeError(f"Repair did not stick for {resource}/{record['id']}: {stored!r}")


def run():
    allow_accented = accented_urls_allowed()
    records = collect_records()

    fixed = 0
    for record in records:
        if is_valid_slug(record["link_rewrite"], allow_accented):
            continue
        candidate = slugify(record["name"])
        log.warning(
            "Invalid link_rewrite. resource=%s id=%s id_lang=%s old=%r %s new=%r",
            record["resource"], record["id"], record["id_lang"], record["link_rewrite"],
            "would set" if DRY_RUN else "setting", candidate,
        )
        if not DRY_RUN:
            apply_repair(record, candidate)
            log.info(
                "Fixed %s/%s. Confirm the 301 redirect preference is on so old links do not 404.",
                record["resource"], record["id"],
            )
        fixed += 1
    log.info("Done. %d slug(s) %s. DRY_RUN=%s.", fixed, "to fix" if DRY_RUN else "fixed", DRY_RUN)


if __name__ == "__main__":
    run()
