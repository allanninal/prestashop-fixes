# Updating stock via the API can delete the linked product combination

On a multistore PrestaShop install where a shop group shares stock, a combination's `stock_available` row is stored once for the whole group at `id_shop=0`. A `PUT /api/stock_availables/{id}` that includes `id_shop` and `id_shop_group` in the body writes that concrete `id_shop` straight onto the row without normalizing it back to the group's shared scope. The row drifts off the shared `id_shop=0` anchor, the shared-stock lookup no longer finds it for any shop in the group, and the combination reads as zero stock everywhere, as if it had been deleted. The `product_attribute` row itself is never touched. This script snapshots combinations and stock before a write, re-checks them after, and flags rows whose scope drifted while their shop group truly shares stock. It never auto-repairs without a fresh re-confirmation, and defaults to dry run.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/stock-update-deletes-combination/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export PRODUCT_IDS="12,34,56"
export DRY_RUN="true"

python stock-update-deletes-combination/python/stock_update_deletes_combination.py
node   stock-update-deletes-combination/node/stock-update-deletes-combination.js
```

`is_combination_stock_orphaned` (Python) / `isCombinationStockOrphaned` (Node) is a pure function: it returns true only when the combination existed before the write, its shop group has `share_stock` enabled, and the post-write stock row's shop scope drifted off the shared `id_shop=0` anchor or its quantity collapsed to zero from a positive value. Start with `DRY_RUN=true` to review every flagged row and the exact PUT body that would restore it before anything is written. The most durable fix is to stop sending `id_shop` and `id_shop_group` in your own `stock_availables` PUT bodies on shared-stock multistore installs.

## Test

```bash
pytest stock-update-deletes-combination/python
node --test stock-update-deletes-combination/node
```
