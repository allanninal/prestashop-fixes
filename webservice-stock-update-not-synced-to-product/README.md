# Webservice stock update not synced to product quantity

Since PrestaShop 1.5, real stock lives in `stock_available.quantity`, while `product.quantity` on the products resource is a deprecated, denormalized column kept only for backward compatible SQL and exports. A correct PUT to `stock_availables` updates the true stock but does not always refresh that cached column, so `product.quantity` can sit stale or stuck at zero even though the back office shows the right number. This script pulls both values per product, flags any mismatch, and repairs the safe ones by reposting the `stock_availables` row's own unchanged quantity, which forces PrestaShop's internal `Product::updateQuantity()` hook to recompute the cache. It never writes to the products resource to fix quantity.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/webservice-stock-update-not-synced-to-product/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"

python webservice-stock-update-not-synced-to-product/python/webservice_stock_resync.py
node   webservice-stock-update-not-synced-to-product/node/webservice-stock-resync.js
```

`decide_reconciliation` is a pure function: given `product.quantity`, `stock_available.quantity`, `out_of_stock`, and `depends_on_stock`, it returns a status and an action. It only allows an automatic resync (`resync_display_only`) when the shop actually depends on `StockAvailable` for sellability (`depends_on_stock == 1`); everything else, including cases where the field is intentionally decoupled, is returned as `flag_for_review` so a human looks at it instead of the script silently rewriting stock. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest webservice-stock-update-not-synced-to-product/python
node --test webservice-stock-update-not-synced-to-product/node
```
