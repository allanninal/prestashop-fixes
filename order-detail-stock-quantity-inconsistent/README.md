# Order detail stock quantity fields disagree with the real order quantity

`order_detail.product_quantity` (what was ordered) and `order_detail.product_quantity_in_stock` (a snapshot computed separately at order-save time by `Product::getQuantity()` and the stock logic) are never transactionally reconciled. Regressions in that computation (see PrestaShop GitHub issue #16840) and edge cases like disabled stock management, advanced stock management, backorders, or partial refunds can leave `product_quantity_in_stock` at 0 while `product_quantity` still shows the real ordered amount on the same row. This script walks recent orders, reads every order_detail line, and flags any row where the two numbers disagree. It never writes to `order_details`: `product_quantity_in_stock` is a historical snapshot tied to real stock events, so a bulk rewrite can hide a real backorder or oversell event and corrupt the audit trail. Every flagged row is a report line for a human to review.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/order-detail-stock-quantity-inconsistent/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export ORDER_DATE_FROM="2026-07-01"
export DRY_RUN="true"

python order-detail-stock-quantity-inconsistent/python/check_order_detail_stock.py
node   order-detail-stock-quantity-inconsistent/node/check-order-detail-stock.js
```

`is_stock_quantity_inconsistent` (Python) / `isStockQuantityInconsistent` (Node) is a pure function: it returns true when `product_quantity` is greater than zero and `product_quantity_in_stock` does not equal `product_quantity` minus `product_quantity_refunded`. The script only ever reads and logs; there is no write path to `order_details` to switch on. If a human confirms a flagged row is genuinely wrong after checking the real stock state at order time, the manual remediation is a targeted `PUT` to `order_details/{id}` correcting `product_quantity_in_stock` alone, never a bulk automated write.

## Test

```bash
pytest order-detail-stock-quantity-inconsistent/python
node --test order-detail-stock-quantity-inconsistent/node
```
