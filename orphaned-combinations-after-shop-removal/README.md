# Orphaned combinations remain linked after a product is removed from a shop

In multistore, a product's shop association lives in `product_shop`, but each combination's per-shop presence lives in a separate table, `product_attribute_shop`. Removing a shop from a product (unchecking it in the Shops association panel, or through Product V2) only cleans up `product_shop`. Core does not cascade that removal to the combination's `product_attribute_shop` rows, a documented bug ([PrestaShop/PrestaShop#30751](https://github.com/PrestaShop/PrestaShop/issues/30751)). This script lists active shops, reads a product's own shop associations, lists its combinations, and checks each combination against every shop it should no longer belong to. There is no webservice route to delete a single `product_attribute_shop` row, so it only reports the orphaned `(id_product, id_product_attribute, id_shop)` tuples for a human or database admin to review.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/orphaned-combinations-after-shop-removal/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export PRODUCT_IDS="12,34,56"
export DRY_RUN="true"

python orphaned-combinations-after-shop-removal/python/orphaned_combination_shops.py
node   orphaned-combinations-after-shop-removal/node/orphaned-combination-shops.js
```

`find_orphaned_combination_shops` (Python) / `findOrphanedCombinationShops` (Node) is a pure function: given the product's own shop ids, the set of active shop ids, and a list of `{id_product_attribute, id_shop}` rows observed through per-shop combination lookups, it returns every row that is orphaned, tagged with `"shop_unassigned_from_product"` or `"shop_inactive"`. The script only reports; it never calls a delete route, because the `combinations` resource can only remove a combination wholesale with `DELETE /api/combinations/{id}`, which would strip it from every shop, not just the stale one. Review the report, then have a database admin run a scoped `DELETE FROM ps_product_attribute_shop WHERE id_product_attribute=? AND id_shop=?` outside the webservice, or apply the core fix that cascades the shop disassociation.

## Test

```bash
pytest orphaned-combinations-after-shop-removal/python
node --test orphaned-combinations-after-shop-removal/node
```
