# Stock quantity goes negative after ordering an out of stock product

PrestaShop lets a product be ordered at zero stock whenever its `out_of_stock` setting allows it, or when `depends_on_stock` is 0 for a pack or virtual product. When the order is validated, `StockAvailable::updateQuantity()` subtracts the ordered amount from `ps_stock_available.quantity` without first checking whether stock is already at zero, so the row goes negative. This script is a **Reconciler**: it scans `stock_availables` for negative, stock-tracked rows and reports them, and only clamps `quantity` back to 0 once an operator confirms.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/negative-stock-quantity-after-order/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"

python negative-stock-quantity-after-order/python/reconcile_negative_stock.py
node   negative-stock-quantity-after-order/node/reconcile-negative-stock.js
```

`decide_stock_reconciliation` (Python) and `decideStockReconciliation` (Node) are pure functions: a row only needs a fix when its `quantity` is negative and `depends_on_stock` is 1, meaning a simple product that is actually stock-tracked. A negative quantity on a pack or virtual product (`depends_on_stock` 0) is expected and benign and is left alone. The only write is `quantity`, clamped to 0, on rows already confirmed negative and tracked; `out_of_stock` and `depends_on_stock` are always sent back unchanged. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest negative-stock-quantity-after-order/python
node --test negative-stock-quantity-after-order/node
```
