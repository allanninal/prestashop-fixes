# Product duplication leaves a broken partial product after an error

PrestaShop's product duplication runs as a long, non-transactional sequence of separate inserts: the base product row first, then a loop over combinations, features, images, accessories, tags, and specific prices. If any single step throws, PrestaShop shows a 500 error but never rolls back the new product row already committed in the first step, leaving a broken, often still active, partial product in the catalog.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/broken-product-duplicate-after-error/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DATE_FROM="2026-07-01"
export DATE_TO="2026-07-11"
export DRY_RUN="true"

python python/find_broken_duplicates.py
node   node/find-broken-duplicates.js
```

`classify_duplicate_integrity` is a pure function: it takes already-fetched product, combination, feature, and stock data and returns one of `OK`, `MISSING_COMBINATIONS`, `MISSING_FEATURES`, `ORPHANED_STOCK`, or `SUSPECT_PARTIAL_DUPLICATE`. The script only reports by default. Set `DRY_RUN=false` to let it deactivate (`active=0`) a product it classifies as a suspect partial duplicate. It never deletes a product and never tries to recreate missing combinations, features, or images, since guessing what to rebuild from the outside is unsafe.

## Test

```bash
pytest broken-product-duplicate-after-error/python
node --test broken-product-duplicate-after-error/node
```
