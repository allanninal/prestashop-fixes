# Default combination duplicate key

Setting `default_on` on a PrestaShop combination through the Webservice API can throw a SQL duplicate entry error for key `product_default`. `ps_product_attribute` allows only one row per `id_product` to hold `default_on=1`, and the back office clears the old default before setting the new one in a single save. The Webservice API does not do that clearing step for you, so PUTting `default_on=1` on a new combination while another one still holds it collides with the unique key.

This script reads the combinations for a product, finds whichever one currently holds `default_on=1`, and if it is not already the target, clears it first with one PUT, then sets `default_on=1` on the target with a second PUT. If the target is already the default it does nothing.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/webservice-default-combination-duplicate-key/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export TARGET_ID_PRODUCT="42"
export TARGET_ID_COMBINATION="17"
export DRY_RUN="true"

python python/swap_default_combination.py
node   node/swap-default-combination.js
```

`plan_default_swap` is a pure function: given the id currently flagged default and the id you want as the new default, it returns an empty list when they already match, otherwise the two writes in the only order that avoids the `product_default` unique key collision, clear the old default first, then set the new one. Start with `DRY_RUN=true` to review the plan before it writes.

## Test

```bash
pytest python
node --test node
```
