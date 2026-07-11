# Category created via webservice ignores shop scoping in multistore

A category created or updated through the PrestaShop webservice with a plain POST or PUT to `/api/categories` silently attaches to every shop in the current shop context unless the request explicitly scopes the write with `id_shop`. The categories schema exposes `id_shop_default`, but that field only marks which shop is used for display, it is not an association list and it does not restrict which `ps_category_shop` rows get written. This job lists the shops in the install, pulls back the categories your integration wrote, and runs a pure decision function that flags any category whose associated shops go beyond what you intended. It reports by default; a corrective PUT is only sent when explicitly confirmed.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/webservice-category-ignores-shop-scope/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export EXPECTED_SHOP_IDS="1"
export DRY_RUN="true"

python webservice-category-ignores-shop-scope/python/flag_category_shop_scope.py
node   webservice-category-ignores-shop-scope/node/flag-category-shop-scope.js
```

`is_over_associated` is a pure function: a category is flagged when its resolved shop ids (from `associations.shops` when available, otherwise `id_shop_default`) go beyond the expected set, or when it is associated with every shop while the expected set is narrower. The only write is a scoped PUT that resends the identical category body with `id_shop` on the query string, and it only runs when `DRY_RUN=false` and `--confirm` is passed, one category id at a time. Start with `DRY_RUN=true` to review the flagged list first.

## Test

```bash
pytest webservice-category-ignores-shop-scope/python
node --test webservice-category-ignores-shop-scope/node
```
