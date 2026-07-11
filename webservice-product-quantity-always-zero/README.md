# Webservice product quantity always reads or writes as zero

Product quantity field via webservice always reads or writes as zero

Since PrestaShop 1.5, physical stock lives in a dedicated `stock_availables` row keyed by `id_product` (and `id_product_attribute` for combinations), not in the `products` table. The webservice `products` resource still exposes a legacy `quantity` field for backward compatibility, but it was never wired to `stock_availables.quantity`, so every GET on it returns 0 and every PUT or POST to it silently no-ops. This script lists products, ignores that legacy field entirely, fetches the real quantity from `stock_availables`, and flags or repairs only that row, never the product.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/webservice-product-quantity-always-zero/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"

python webservice-product-quantity-always-zero/python/sync_stock_quantity.py
node   webservice-product-quantity-always-zero/node/sync-stock-quantity.js
```

`decide_quantity_sync` is a pure function: it always ignores the legacy `products.quantity` field, flags a product when no `stock_availables` row exists, flags an active and visible product whose real quantity is unexpectedly zero or negative, and only recommends a `patch_stock_available` action when `DRY_RUN=false` and a target quantity is known. Anything ambiguous is reported for a human to reconcile instead of written automatically. The only sanctioned write is a `PATCH /api/stock_availables/{id}` with the corrected `quantity`; `products.quantity` is never written, since it is a no-op field. Start with `DRY_RUN=true` to review the flagged rows first.

## Test

```bash
pytest webservice-product-quantity-always-zero/python
node --test webservice-product-quantity-always-zero/node
```
