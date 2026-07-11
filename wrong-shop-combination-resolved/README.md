# Combination resolved from the wrong shop context in multistore

Combinations are shared in one `product_attribute` row, but price, impact, and default-attribute fields live in the per-shop `product_attribute_shop` association table. Historically the assembler code that resolves a product's combination, `ProductAssemblerCore::addMissingProductFields` and `cache_default_attribute` lookups such as `getIdProductAttributeByIdAttributes`, queried `product_attribute` and `product_attribute_shop` without consistently filtering by `id_shop`, so it could resolve an `id_product_attribute` that only has an association row for a sibling shop (PrestaShop/PrestaShop issue 17573). The symptom is a combination showing price 0 or the wrong `minimal_quantity` in one shop only. This job enumerates shops, lists each shop's products, reads the resolved combination per shop, and cross-checks it against `stock_availables` to learn which shops a combination is actually associated with. It reports by default; a guarded corrective PUT is only sent when explicitly confirmed.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/wrong-shop-combination-resolved/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"

python wrong-shop-combination-resolved/python/find_shop_mismatch.py
node   wrong-shop-combination-resolved/node/find-shop-mismatch.js
```

`find_shop_mismatched_combinations` is a pure function: a combination is flagged when the shop it was resolved for is not among the shops it is actually associated with (derived from cross-checking `stock_availables` per `id_product_attribute` and `id_shop`). The only write is a guarded PUT that resends the combination's existing body to `/api/combinations/{id_product_attribute}` scoped with `?id_shop=`, and it only runs when `DRY_RUN=false` and `--confirm` is passed, one `id_product_attribute` and `id_shop` pair at a time. It never deletes or reassigns the core `product_attribute` row. Start with `DRY_RUN=true` to review the flagged list first.

## Test

```bash
pytest wrong-shop-combination-resolved/python
node --test wrong-shop-combination-resolved/node
```
