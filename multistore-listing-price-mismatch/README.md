# Catalog listing shows the wrong price when currency differs per shop

In PrestaShop multistore, per shop overrides for price and discounts live in `ps_product_shop` and `ps_specific_price`, keyed by `id_shop` or `id_shop_group`, while the base `ps_product` row holds only a default fallback value. Several core controllers and list queries, notably the backoffice Catalog product list, join or read from `ps_product` instead of the shop scoped table, and price resolution can also fail to filter strictly by the loaded shop, so a listing can surface one shop's price or discount while the single product page shows a different shop's real price for the same `id_product`. This job reads the listing context price and the single product context price for every product and shop pair and flags any difference beyond a rounding tolerance. It reports by default; a corrective write is only sent when explicitly confirmed and re-verified.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/multistore-listing-price-mismatch/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export PRICE_TOLERANCE="0.01"
export ID_PRODUCT_START="1"
export ID_PRODUCT_END="1"
export DRY_RUN="true"

python multistore-listing-price-mismatch/python/diagnose_multistore_listing_price.py
node   multistore-listing-price-mismatch/node/diagnose-multistore-listing-price.js
```

`decide_price_mismatch` is a pure function: it takes the listing context price and the single product context price for one `id_product` and `id_shop`, and flags a mismatch when the absolute difference is larger than `tolerance` (default `0.01` in the shop's currency). Most mismatches trace back to a core price resolution bug between `ps_product` and `ps_product_shop`, or a mis-scoped `specific_price` row, so the script only reports by default. The one guarded repair path, used only when `DRY_RUN=false`, sends a single scoped `PUT` with the correct price for that `id_shop` and then re-fetches both views to verify the fix actually landed. Start with `DRY_RUN=true` to review the flagged list first.

## Test

```bash
pytest multistore-listing-price-mismatch/python
node --test multistore-listing-price-mismatch/node
```
