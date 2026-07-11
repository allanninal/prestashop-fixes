# Combination stock quantities do not sum to the product level total

PrestaShop stores stock in a single `stock_available` table with one row per `(id_product, id_product_attribute, id_shop)`. The row where `id_product_attribute` is 0 holds the product-level quantity, and it is only kept equal to the sum of the combination rows by application code such as `StockAvailable::synchronizeOne`, never by a live `SUM()` or a database constraint. Deleting and recreating combinations, direct SQL or ERP writes, and advanced stock management setups can all leave the two figures disagreeing. This script reports the mismatch and any orphaned stock rows left behind by deleted combinations. It never writes a combination row, and it only writes the product-level row when a mismatch is confirmed and `DRY_RUN` is off.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/combination-quantity-sum-mismatch/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export PRESTASHOP_SHOP_ID="1"
export PRODUCT_IDS="10,25,42"
export DRY_RUN="true"

python combination-quantity-sum-mismatch/python/combination_quantity_sum_mismatch.py
node   combination-quantity-sum-mismatch/node/combination-quantity-sum-mismatch.js
```

`find_stock_mismatches` (Python) / `findStockMismatches` (Node) is a pure function: it scopes the stock rows to the requested shop, sums the quantities of combination rows whose `id_product_attribute` is still in the live combinations list, flags any row that is not (an orphan left behind by a deleted combination), and returns the signed delta between the product-level row and that sum. A product with zero combinations is never flagged. Start with `DRY_RUN=true` to review the report before anything is written. Even with `DRY_RUN=false`, the only write is a `PUT` on the product-level `stock_available` row, and only when a mismatch is confirmed; combination rows and orphaned rows are always left for manual review.

## Test

```bash
pytest combination-quantity-sum-mismatch/python
node --test combination-quantity-sum-mismatch/node
```
