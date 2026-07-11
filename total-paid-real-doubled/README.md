# Total paid real field doubles after a partial payment update

`Order::addOrderPayment()` both inserts a row into `order_payment` and directly increments the order's own `total_paid_real` column before saving the order. Nothing checks whether a matching payment already exists, so a partial-payment workflow that triggers this method twice for the same real-world payment, for example an auto-added payment from `Order::validateOrder()` plus a separate order_history update or a payment module call, leaves `order_payment` with a duplicate row and `total_paid_real` incremented twice. The stored total can end up exactly double the true sum of the real payment rows.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/total-paid-real-doubled/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export ORDER_IDS="101,102,103"
export DRY_RUN="true"

python total-paid-real-doubled/python/reconcile_total_paid_real.py
node   total-paid-real-doubled/node/reconcile-total-paid-real.js
```

`reconcile_payment` is a pure function: it sums the order's real `order_payment` amounts, compares that sum to the stored `total_paid_real` within a small rounding tolerance, and separately flags when the stored total is close to exactly twice the real sum (or twice `total_paid` when no payment rows exist yet), which is the signature of the duplicate `addOrderPayment()` bug rather than an ordinary partial-payment shortfall.

The script only ever reports by default. It never rewrites `total_paid_real` on its own, since `order_payment` is the source of truth. A corrective write only happens when `DRY_RUN=false` and `CONFIRM_DUPLICATE_PAYMENT_ID` is set to the id of a specific `order_payment` row a human has confirmed is a true duplicate. That row is deleted first, then `total_paid_real` is set to the recomputed sum of the remaining rows.

## Test

```bash
pytest total-paid-real-doubled/python
node --test total-paid-real-doubled/node
```
