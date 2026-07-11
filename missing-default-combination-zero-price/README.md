# Product has no default combination, causing price to display as zero

A product with combinations shows its headline price by resolving `id_default_combination` to one specific combination row. When that pointer is 0, blank, or names a combination that was deleted, deactivated, or belongs to a different product, the price lookup has nothing valid to read and the product displays a price of zero even though its other combinations have real prices. This script lists products, pulls each one's live combinations, and repairs a stale pointer to the cheapest eligible active combination it can find, or flags the product for a human when no eligible combination exists.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/missing-default-combination-zero-price/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"

python missing-default-combination-zero-price/python/fix_default_combination.py
node   missing-default-combination-zero-price/node/fix-default-combination.js
```

`decide_default_combination` (Python) / `decideDefaultCombination` (Node) is a pure function: given a product id, its stored default combination id, and the list of that product's live combinations, it returns `none` when the stored id already resolves to an active combination that belongs to the product, `repair` with the cheapest eligible combination's id when the stored id is missing or stale, and `flag` when no active combination belongs to the product at all. It never picks a combination that is inactive or that belongs to a different product. Start with `DRY_RUN=true` to review the report before anything is written. Even with `DRY_RUN=false`, the only write is a `PUT` on the product's own `id_default_combination` field; combination rows are never modified.

## Test

```bash
pytest missing-default-combination-zero-price/python
node --test missing-default-combination-zero-price/node
```
