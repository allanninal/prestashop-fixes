# Stock quantity formula drift

Physical quantity, reserved quantity, and virtual quantity fall out of sync

PrestaShop's `stock_availables` table stores three numbers per product or combination that should always reconcile: `physical_quantity` (units on the shelf), `reserved_quantity` (units allocated to unshipped or unpaid orders), and `quantity` (the virtual sellable quantity, physical minus reserved). Documented core bugs and direct writes from modules, CSV import, or the webservice let these three fields drift apart, and PrestaShop has no built-in reconciliation job. This script recomputes the expected reserved quantity by walking open orders, flags any `stock_availables` row that breaks `physical_quantity = quantity + reserved_quantity`, and, only when explicitly authorized, corrects `quantity` (never `reserved_quantity` or `physical_quantity`, which are core-managed).

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/stock-quantity-formula-drift/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export PRODUCT_IDS="12,45,103"
export DRY_RUN="true"

python stock-quantity-formula-drift/python/check_stock_invariant.py
node   stock-quantity-formula-drift/node/check-stock-invariant.js
```

`checkStockInvariant` is a pure function: it takes the stored stock row and a recomputed reserved quantity, and returns whether the formula holds, whether the reserved figure matches, and what the corrected quantity should be. The only sanctioned write, when `DRY_RUN=false`, is `PUT /api/stock_availables/{id}` setting `quantity = physical_quantity - computed_reserved_quantity`. `reserved_quantity` and `physical_quantity` are left untouched by design; re-trigger the correct `order_histories` transition or run a back-office stock regularization to fix the underlying drift. Start with `DRY_RUN=true` to review the flagged rows first.

## Test

```bash
pytest stock-quantity-formula-drift/python
node --test stock-quantity-formula-drift/node
```
