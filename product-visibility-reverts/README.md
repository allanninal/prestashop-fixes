# Product visibility reverts

A merchant hides a product for one shop, or sets it to catalog only, through the PrestaShop webservice. It sticks for a while, then a scheduled sync job PUTs the full product resource from an external source of truth that never tracked the override, and visibility silently reverts to `both`. Multistore installs make this worse because of a long standing webservice bug where a PUT does not reliably honor `id_shop` scoping, so a change meant for one shop can land on, or be read back from, the default shop instead.

This reconciler keeps an intended-state list of `(product_id, id_shop)` to visibility, reads the real value scoped by `id_shop`, and reapplies a drifted value exactly once with a scoped PUT. If the same pair reverts again after that one reapply, it stops writing and flags the pair for a human instead of looping against a job it cannot see.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/product-visibility-reverts/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"
export REPAIRED_ONCE_STATE_FILE="repaired_once.json"

python product-visibility-reverts/python/reconcile_visibility.py
node   product-visibility-reverts/node/reconcile-visibility.js
```

`decide_visibility_action` is a pure function: for each `(product_id, id_shop)` key in your intended-state map, it compares the actual visibility read back from PrestaShop against the intended value. If they match, no action. If they differ and the pair has not been repaired before, it reapplies once. If they differ and the pair was already repaired once, it flags the pair instead of writing again, so the script never fights a competing sync job in an endless loop. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest product-visibility-reverts/python
node --test product-visibility-reverts/node
```
