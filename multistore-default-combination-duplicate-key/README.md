# Duplicate key error creating a default combination per shop in multistore

In PrestaShop multistore, the default combination flag is meant to be scoped per shop through `product_attribute_shop`, but the unique index behind `product_default` was not always shop aware in older 1.6 style code paths. Creating or converting a default combination on a second shop can then collide with the default already set on the first shop, and the failed write can leave a shop with two combinations flagged `default_on=1`, or with none at all.

This is a diagnostic first tool. It reads every shop, then for each product in a given id range pulls that product's combinations filtered to each `id_shop` and classifies the state with a pure function. It only reports by default. Set `DRY_RUN=false` to also apply a two step repair per flagged product and shop.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/multistore-default-combination-duplicate-key/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export ID_PRODUCT_START="1"
export ID_PRODUCT_END="200"
export DRY_RUN="true"

python multistore-default-combination-duplicate-key/python/diagnose_multistore_default_combination.py
node   multistore-default-combination-duplicate-key/node/diagnose-multistore-default-combination.js
```

`classify_default_combination_state` is a pure function: given the combinations list for one product in one shop context, the product's `id_default_combination` pointer, and whether the shop is active, it returns one of `OK`, `DUPLICATE_DEFAULT`, `MISSING_DEFAULT`, `POINTER_MISMATCH`, or `NOT_APPLICABLE`. The script only reports these findings by default; it writes nothing until `DRY_RUN=false`, and even then it clears every extra default row in a shop first, one PUT per `id_product_attribute`, before pointing `id_default_combination` at the surviving row.

Start with `DRY_RUN=true` to review the findings before letting it write.

## Test

```bash
pytest multistore-default-combination-duplicate-key/python
node --test multistore-default-combination-duplicate-key/node
```
