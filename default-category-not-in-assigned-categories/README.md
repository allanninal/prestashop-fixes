# Product's default category is not among its assigned categories

PrestaShop's backend product editor writes category associations to `category_product` instantly, over AJAX, the moment a merchant checks or unchecks a box, without waiting for Save. It never re-validates `id_category_default` at that moment. If the category that was the default gets unchecked, or a category is deleted store-wide, `id_category_default` keeps pointing at a category the product is no longer linked to. Catalog import can cause the same drift when only partial category data is sent for a row.

This job pages through active products from the webservice, runs a pure decision function that flags any product where `id_category_default` is not in its `associations.categories.category[]` ids, and reports by default. A corrective PUT that resends the full product body with only `id_category_default` corrected is only sent when `DRY_RUN=false` and `--auto-fix` is passed, one product id at a time.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/default-category-not-in-assigned-categories/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export ROOT_CATEGORY_ID="2"
export DRY_RUN="true"

python default-category-not-in-assigned-categories/python/flag_default_category_drift.py
node   default-category-not-in-assigned-categories/node/flag-default-category-drift.js

# once you have reviewed the flagged list and are ready to repair:
export DRY_RUN="false"
python default-category-not-in-assigned-categories/python/flag_default_category_drift.py --auto-fix
node   default-category-not-in-assigned-categories/node/flag-default-category-drift.js --auto-fix
```

`find_default_category_drift` is a pure function: a product is flagged only when its `id_category_default` is not present in its own assigned category ids. There is no deterministic correct replacement, so the script reports by default. `--auto-fix` uses the lowest id currently in the product's associations as the deterministic fallback (or `ROOT_CATEGORY_ID` if associations is empty), and always resends the full product body on the PUT rather than a partial payload. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest default-category-not-in-assigned-categories/python
node --test default-category-not-in-assigned-categories/node
```
