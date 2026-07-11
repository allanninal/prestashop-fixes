# Friendly URL field accepts invalid values instead of a proper slug

PrestaShop's webservice layer validates most product fields strictly, but it does not consistently run `link_rewrite` through `Validate::isLinkRewrite()` on every write path, and `Tools::str2url()` has in some PS8 releases stopped stripping every disallowed character. That gap lets a raw title, a full URL, or Unicode punctuation land straight in the `link_rewrite` column. This script pulls every product, category, manufacturer, and CMS page `link_rewrite` per language through the webservice, tests each value against the same regex PrestaShop itself enforces, and repairs any value that fails with a slug built from the record's own name.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/invalid-friendly-url-format-accepted/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"

python invalid-friendly-url-format-accepted/python/fix_invalid_friendly_url_format.py
node   invalid-friendly-url-format-accepted/node/fix-invalid-friendly-url-format.js
```

`is_valid_slug` (Python) / `isValidSlug` (Node) is a pure function: given a `link_rewrite` value and whether the store allows accented URLs, it mirrors PrestaShop's own `Validate::isLinkRewrite()`, letters, digits, underscores, and hyphens only, or that same set plus accented letters, and additionally rejects empty strings and any value containing a space, dot, slash, colon, or backslash. Start with `DRY_RUN=true` to review the report before anything is written. When `DRY_RUN=false`, the script fetches the full resource body, replaces only the flagged language's `link_rewrite` entry with a slug generated from the record's own name, `PUT`s the whole body back, and re-fetches to confirm the stored value now passes the check. Turn on PrestaShop's "Set up a 301 redirect when the URL is changed" preference before running for real, since a repair changes a public URL.

## Test

```bash
pytest invalid-friendly-url-format-accepted/python
node --test invalid-friendly-url-format-accepted/node
```
