# Default category overwritten by import

PrestaShop's product CSV importer builds each row independently from the Category column. When multiple category ids or names are comma separated it has historically picked the first one in the list, or in older "Force ID" flows silently reset `id_category_default` to whatever the file's ordering implies, rather than preserving the product's prior default. A re-export and re-import round trip, or a partial update file that omits the category column, can shift the default to category id 2 (Home) or some other unintended category without any error. In multistore installs the default is scoped per shop, so an import run without shop scoping can overwrite the wrong shop's default.

This job snapshots every affected product's `id_category_default` before an import, re-reads the same products after, and runs a pure decision function that classifies each product as unchanged, needing manual review (flag), or a safe automatic repair candidate (the classic "reset to Home" signature). A restoring `PUT` is only sent when `DRY_RUN=false`, scoped per shop, and only for the repair action.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/default-category-overwritten-by-import/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export ROOT_CATEGORY_ID="2"
export DRY_RUN="true"
export PRODUCT_IDS="101,102,103"

# Snapshot before your import, run the import yourself, then check the same ids after:
python default-category-overwritten-by-import/python/reconcile_import_default_category.py
node   default-category-overwritten-by-import/node/reconcile-import-default-category.js
```

`decide_category_repair` is a pure function: given a product's `id_category_default` before and after the import, plus its post-import associated category ids, it returns `none` when nothing changed, `flag` when a human should confirm (an ambiguous change, or the prior default was dropped from the associations entirely), or `repair` only for the classic "reset to Home" signature, where the prior default is still associated but the post-import default became the root category. Only `repair` ever triggers a write, and only when `DRY_RUN=false`. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest default-category-overwritten-by-import/python
node --test default-category-overwritten-by-import/node
```
