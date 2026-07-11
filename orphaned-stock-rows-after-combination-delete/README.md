# Orphaned stock rows remain after a combination is deleted

There is no enforced cascade between PrestaShop's `combinations` (`product_attribute`) and `stock_available`. Deleting a combination through the Back Office or the `combinations` webservice resource can leave its `stock_available` row behind, still holding quantity, still summed into the product's displayed total stock, even though no live combination corresponds to it. This script lists a product's live combinations and every stock row tied to it, finds rows whose `id_product_attribute` matches no live combination, and removes them, always re-confirming on a fresh fetch immediately before deleting to avoid a race with a combination created between detection and repair.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/orphaned-stock-rows-after-combination-delete/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export PRODUCT_IDS="12,34,56"
export DRY_RUN="true"

python orphaned-stock-rows-after-combination-delete/python/orphaned_stock_rows.py
node   orphaned-stock-rows-after-combination-delete/node/orphaned-stock-rows.js
```

`find_orphan_stock_rows` (Python) / `findOrphanStockRows` (Node) is a pure function: it builds the set of live `id_product_attribute` values from the combinations list (always including `0` for the base product's own stock row) and returns every stock row whose `id_product_attribute` is not in that set. Start with `DRY_RUN=true` to review the candidate rows, their quantity, and their `id_shop` before anything is deleted.

## Test

```bash
pytest orphaned-stock-rows-after-combination-delete/python
node --test orphaned-stock-rows-after-combination-delete/node
```
