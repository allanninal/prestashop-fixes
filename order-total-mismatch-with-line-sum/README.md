# Order total does not match the sum of its order lines

PrestaShop caches an order's total_paid, total_paid_tax_incl, and total_paid_tax_excl on the orders table separately from each line's own total on the order_detail table. The two are only reconciled by specific code paths, cart validation and the OrderAmountUpdater run during a back office edit, so a rounding-mode setting, a module writing straight to the order totals, or a back office edit to a line, a discount, or a partial refund can leave them out of step. This job pulls each order's header and its order_detail rows, computes what the total should be from the lines plus shipping minus discounts, and flags every order where that computed total disagrees with the stored total_paid_tax_incl by more than a small rounding tolerance.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/order-total-mismatch-with-line-sum/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export ORDER_ID_RANGE="1,50"
export DRY_RUN="true"

python order-total-mismatch-with-line-sum/python/check_order_total.py
node   order-total-mismatch-with-line-sum/node/check-order-total.js
```

`diff_order_total` is a pure function: it sums the line totals, adds shipping, subtracts discounts, and compares that against the order's stored total_paid_tax_incl with a small tolerance for rounding. This is unsafe to auto-fix, so the script reports every mismatch by default and never overwrites totals unless DRY_RUN is explicitly false, in which case it re-checks order_histories for a pending state change or refund before attempting a corrective write.

## Test

```bash
pytest order-total-mismatch-with-line-sum/python
node --test order-total-mismatch-with-line-sum/node
```
