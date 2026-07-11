# Duplicate key error when updating stock quantity concurrently

`ps_stock_available` has a unique key (`product_sqlstock`) on `id_product`, `id_product_attribute`, `id_shop`, and `id_shop_group`. `StockAvailable::setQuantity()` selects a row for that key first, then decides whether to update or insert. Two near-simultaneous writes, such as a webservice PUT racing a checkout or another webservice call, can both miss each other's row and both try to insert, so the second one hits a duplicate entry error on `product_sqlstock`. Multistore installs can also end up with an orphan row scoped to `id_shop=0` and `id_shop_group=0` instead of the real shop.

This script enumerates `stock_availables` for a product, groups the rows by that same natural key, and reports any group with more than one row as a true duplicate. It also cross-checks against `combinations` to flag stock rows whose `id_product_attribute` no longer exists on the product.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/stock-available-duplicate-key-error/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export TARGET_ID_PRODUCT="123"
export DRY_RUN="true"

python stock-available-duplicate-key-error/python/find_duplicate_stock.py
node   stock-available-duplicate-key-error/node/find-duplicate-stock.js
```

`find_duplicate_stock_rows` is a pure function: it groups a list of `stock_availables` records by `(id_product, id_product_attribute, id_shop, id_shop_group)` and returns only the groups with more than one row, sorted so the keep candidate (a real `id_shop` over `0`, then the highest `id`) sorts first. This is a report-first, flag-by-default fix. With `DRY_RUN=true` (the default) it only logs the duplicate groups and orphaned rows it finds. Only set `DRY_RUN=false` after you have reviewed the before and after quantities and are ready to let it PUT the merged keep row and DELETE the extra rows.

## Test

```bash
pytest stock-available-duplicate-key-error/python
node --test stock-available-duplicate-key-error/node
```
