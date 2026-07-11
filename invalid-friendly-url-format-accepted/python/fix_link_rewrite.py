"""Detect and, when explicitly requested, repair PrestaShop link_rewrite values
that do not match Validate::isLinkRewrite() despite having been auto-generated
or written through the webservice.

PrestaShop stores each SEO-friendly URL slug in a link_rewrite field, present
per language on products, categories, CMS pages, manufacturers, and suppliers.
The value is supposed to satisfy Validate::isLinkRewrite(), whose regex only
allows [_a-zA-Z0-9-] (plus \\pL when accented URLs are enabled). No dots,
slashes, spaces, or scheme fragments. In practice the back office generates the
slug from the object name via Tools::str2url(), and that helper has not always
reliably stripped every character the validator rejects (PrestaShop/PrestaShop
issue #38161). Separately, the webservice API path has been shown to accept
clearly invalid values such as "abc.com" on product creation without raising
the expected "invalid field value" error (PrestaShop/PrestaShop issue #13151).
The mismatch between the lenient/buggy generator and the stricter validator
lets full URLs, dots, or stray punctuation land in link_rewrite, which later
breaks Apache/Nginx rewrite rules and produces 404s or duplicate-URL conflicts.

This script lists products, categories, manufacturers, and CMS pages through
the webservice, tests every language-keyed link_rewrite value against the same
rule PrestaShop enforces, and reports anything invalid. Rewriting link_rewrite
changes public URLs and can 404 already-indexed or backlinked pages, so by
default this only flags. When DRY_RUN=false, it regenerates a compliant slug
from the source name, checks it is unique among sibling slugs, and PUTs the
full existing resource body back with only the link_rewrite node replaced.

Run on a schedule, or on demand before a catalog import. Safe to run again and
again: an already-valid link_rewrite is always left untouched.
"""
import os
import re
import logging
import unicodedata
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_link_rewrite")

PRESTASHOP_URL = os.environ["PRESTASHOP_URL"].rstrip("/")
PRESTASHOP_WS_KEY = os.environ["PRESTASHOP_WS_KEY"]
ALLOW_ACCENTED_CHARS = os.environ.get("ALLOW_ACCENTED_CHARS", "false").lower() == "true"
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTH = (PRESTASHOP_WS_KEY, "")

MAX_LINK_REWRITE_LENGTH = 128

ASCII_LINK_REWRITE_RE = re.compile(r"^[_a-zA-Z0-9-]+$")
ACCENTED_LINK_REWRITE_RE = re.compile(r"^[_a-zA-Z0-9\-À-ɏ]+$", re.UNICODE)

RESOURCE_PATHS = {
    "products": "products",
    "categories": "categories",
    "manufacturers": "manufacturers",
    "cms": "cms",
}


def is_link_rewrite(value, allow_accented_chars):
    """Mirrors Validate::isLinkRewrite(). No I/O."""
    if not isinstance(value, str) or not value:
        return False
    if len(value) > MAX_LINK_REWRITE_LENGTH:
        return False
    pattern = ACCENTED_LINK_REWRITE_RE if allow_accented_chars else ASCII_LINK_REWRITE_RE
    return bool(pattern.match(value))


def slugify(source_name, allow_accented_chars):
    """Normalize a source name into a candidate link_rewrite. No I/O."""
    if not source_name:
        return ""
    text = source_name.strip().lower()
    if not allow_accented_chars:
        text = unicodedata.normalize("NFKD", text)
        text = "".join(ch for ch in text if not unicodedata.combining(ch))
    if allow_accented_chars:
        text = re.sub(r"[^_a-zA-Z0-9\-À-ɏ]+", "-", text)
    else:
        text = re.sub(r"[^_a-zA-Z0-9-]+", "-", text)
    text = re.sub(r"-{2,}", "-", text)
    return text.strip("-")


def decide_slug_fix(current_slug, source_name, allow_accented_chars, existing_slugs_for_siblings):
    """Pure decision function, no I/O.

    current_slug: the stored link_rewrite value to validate.
    source_name: the object name to derive a replacement slug from if invalid.
    allow_accented_chars: whether the shop has accented URLs enabled.
    existing_slugs_for_siblings: other link_rewrite values already in use for
        the same resource type, used to keep a proposed slug unique.

    Returns {isValid, proposedSlug, reason}.
    """
    if is_link_rewrite(current_slug, allow_accented_chars):
        return {"isValid": True, "proposedSlug": None, "reason": "ok"}

    if not isinstance(current_slug, str) or not current_slug:
        reason = "empty or non-string value"
    elif len(current_slug) > MAX_LINK_REWRITE_LENGTH:
        reason = "exceeds 128 chars"
    elif "/" in current_slug:
        reason = "contains slash"
    elif "." in current_slug and any(token in current_slug.lower() for token in ("http", ".com", ".html")):
        reason = "contains dot/scheme"
    elif "." in current_slug:
        reason = "contains dot"
    elif " " in current_slug:
        reason = "contains space"
    else:
        reason = "contains disallowed characters"

    candidate = slugify(source_name, allow_accented_chars)
    if not candidate:
        reason = "empty after normalization"
        candidate = "item"

    siblings = set(existing_slugs_for_siblings or [])
    proposed = candidate
    suffix = 2
    while proposed in siblings:
        proposed = f"{candidate}-{suffix}"
        suffix += 1

    return {"isValid": False, "proposedSlug": proposed, "reason": reason}


def api_get(path, params=None):
    params = dict(params or {})
    params["output_format"] = "JSON"
    r = requests.get(f"{PRESTASHOP_URL}/api/{path}", params=params, auth=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()


def api_put_full_resource(resource_type, id_resource, resource_key, full_body):
    r = requests.put(
        f"{PRESTASHOP_URL}/api/{RESOURCE_PATHS[resource_type]}/{id_resource}",
        params={"output_format": "JSON"},
        auth=AUTH,
        json={resource_key: full_body},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def list_resource_ids(resource_type):
    data = api_get(RESOURCE_PATHS[resource_type], params={"display": "[id]"})
    key = resource_type
    return [int(row["id"]) for row in (data.get(key) or [])]


def get_full_resource(resource_type, id_resource):
    resource_key = resource_type[:-1] if resource_type != "cms" else "cms"
    data = api_get(f"{RESOURCE_PATHS[resource_type]}/{id_resource}", params={"display": "full"})
    return data[resource_key]


def link_rewrite_entries(full_resource):
    """Returns a list of {id_lang, value} from the language-keyed link_rewrite field."""
    raw = full_resource.get("link_rewrite")
    if raw is None:
        return []
    if isinstance(raw, str):
        return [{"id_lang": None, "value": raw}]
    language_list = raw.get("language") if isinstance(raw, dict) else None
    if language_list is None:
        return []
    if isinstance(language_list, dict):
        language_list = [language_list]
    entries = []
    for entry in language_list:
        entries.append({"id_lang": entry.get("id"), "value": entry.get("value") or entry.get("#text") or ""})
    return entries


def resource_name_for_slug(full_resource):
    name = full_resource.get("name")
    if isinstance(name, dict):
        language_list = name.get("language")
        if isinstance(language_list, dict):
            language_list = [language_list]
        for entry in language_list or []:
            value = entry.get("value") or entry.get("#text")
            if value:
                return value
        return ""
    return name or ""


def set_link_rewrite_value(full_resource, id_lang, new_value):
    raw = full_resource.get("link_rewrite")
    if isinstance(raw, str):
        full_resource["link_rewrite"] = new_value
        return full_resource
    language_list = raw.get("language")
    if isinstance(language_list, dict):
        language_list = [language_list]
    for entry in language_list:
        if entry.get("id") == id_lang:
            entry["value"] = new_value
    raw["language"] = language_list
    full_resource["link_rewrite"] = raw
    return full_resource


def run():
    flagged = 0
    fixed = 0
    for resource_type in RESOURCE_PATHS:
        sibling_slugs = set()
        ids = list_resource_ids(resource_type)
        full_resources = {}
        for id_resource in ids:
            full = get_full_resource(resource_type, id_resource)
            full_resources[id_resource] = full
            for entry in link_rewrite_entries(full):
                if entry["value"]:
                    sibling_slugs.add(entry["value"])

        for id_resource in ids:
            full = full_resources[id_resource]
            source_name = resource_name_for_slug(full)
            changed = False
            for entry in link_rewrite_entries(full):
                decision = decide_slug_fix(
                    entry["value"], source_name, ALLOW_ACCENTED_CHARS,
                    list(sibling_slugs - {entry["value"]}),
                )
                if decision["isValid"]:
                    continue
                flagged += 1
                log.warning(
                    "%s id=%s lang=%s invalid link_rewrite=%r reason=%s proposed=%r",
                    resource_type, id_resource, entry["id_lang"], entry["value"],
                    decision["reason"], decision["proposedSlug"],
                )
                if DRY_RUN:
                    continue
                set_link_rewrite_value(full, entry["id_lang"], decision["proposedSlug"])
                sibling_slugs.add(decision["proposedSlug"])
                changed = True
            if changed:
                resource_key = resource_type[:-1] if resource_type != "cms" else "cms"
                api_put_full_resource(resource_type, id_resource, resource_key, full)
                fixed += 1
                log.info("Repaired link_rewrite for %s id=%s", resource_type, id_resource)

    log.info("Done. %d invalid slug(s) flagged, %d resource(s) %s.",
              flagged, fixed, "would be written" if DRY_RUN else "written")


if __name__ == "__main__":
    run()
