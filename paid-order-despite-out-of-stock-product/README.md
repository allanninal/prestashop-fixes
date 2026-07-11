# Order reaches a paid state despite the product being out of stock

PrestaShop checks stock when an item is added to the cart, but it never re-verifies `stock_available` against the cart at the final "Order with obligation to pay" step or inside a payment module's `validateOrder()` callback. If stock is depleted by a concurrent order, or a module (COD, Mollie) writes a paid state directly, the order ends up paid while the product's `out_of_stock` policy denies backorders and quantity is 0 or lower. This script is a **Diagnostic**: it audits paid orders against current stock and reports every affected line, and only ever adds an `order_histories` entry to a human-approved review state, never a financial change.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/paid-order-despite-out-of-stock-product/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"
export AUDIT_WINDOW_DAYS="30"
export REVIEW_STATE_ID=""   # optional, human-approved id_order_state to move flagged orders to

python paid-order-despite-out-of-stock-product/python/audit_paid_out_of_stock.py
node   paid-order-despite-out-of-stock-product/node/audit-paid-out-of-stock.js
```

`decide_out_of_stock_paid_flag` (Python) and `decideOutOfStockPaidFlag` (Node) are pure functions: an order line is only flagged when the order's current state is paid, the product's `out_of_stock` policy denies backorders (0), and stock quantity is insufficient for what was ordered or already at zero or below. An order that is not paid is never flagged regardless of stock, and a negative or zero quantity is expected and not flagged when backorders are allowed (1). The script never cancels, refunds, or edits `orders.current_state` directly. The only write, gated by `DRY_RUN=false` and a supplied `REVIEW_STATE_ID`, is a new `order_histories` row moving the order to an existing, human-approved manual-review state. Start with `DRY_RUN=true` to review the flagged list first.

## Test

```bash
pytest paid-order-despite-out-of-stock-product/python
node --test paid-order-despite-out-of-stock-product/node
```
