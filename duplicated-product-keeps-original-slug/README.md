# Duplicating a product keeps the original's friendly URL unchanged

PrestaShop's Duplicate action clones every `ps_product_lang` row, including `link_rewrite`, byte for byte, because the slug is only ever regenerated from the product name inside the admin form's own save path, which the duplication flow never runs. The clone ends up with the exact same friendly URL as the original in every language, and because the product URL is unique on `id_product` plus `link_rewrite` together, nothing errors: both products stay reachable, and the collision only shows up as visually identical URLs and duplicate-content signals to search engines. This script lists every product's slug, name, and creation date, groups them per language, keeps the earliest as the canonical original, and proposes a deterministic new slug for every later duplicate, flagging (not guessing) when a duplicate's name has already diverged from the original.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/duplicated-product-keeps-original-slug/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"

python duplicated-product-keeps-original-slug/python/fix_duplicated_product_slug.py
node   duplicated-product-keeps-original-slug/node/fix-duplicated-product-slug.js
```

`suffix_duplicate_slugs` (Python) / `suffixDuplicateSlugs` (Node) is a pure function: given a single language's product records, it groups them by `link_rewrite`, keeps the earliest by `date_add` (falling back to id) as the unchanged original, and proposes `new_slug = f"{old_slug}-{id}"` for every other member, appending `-dup` if that candidate still collides with any other slug in the full product set. `names_diverged` / `namesDiverged` then decides whether a proposed rename is safe to apply automatically, based on whether the duplicate's name still resembles the original's. Start with `DRY_RUN=true` to review the plan before anything is written. Even with `DRY_RUN=false`, the only write is a `PUT` on the duplicate's own `link_rewrite` field, and diverged-name duplicates are only logged, never renamed.

## Test

```bash
pytest duplicated-product-keeps-original-slug/python
node --test duplicated-product-keeps-original-slug/node
```
