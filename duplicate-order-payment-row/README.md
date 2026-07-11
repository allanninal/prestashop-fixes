# Order payment row duplicated for certain order state configurations

When an order state has both **Consider the associated order as validated** and **Set the order as paid** enabled together, such as a typical bankwire or cheque Payment accepted status, `Order::validateOrder()` with that state triggers two independent code paths that each write a payment row for the same amount. `PaymentModule::validateOrder()` calls `Order::addOrderPayment()` directly, while the invoice-generation path in `OrderInvoice` (`getRestPaid()` / `getTotalPaid()`) still treats the order as owing money on a dummy invoice (invoice number 0) and lets the state-change logic re-trigger a second payment insert. Both writes land in `order_payment` with the identical `id_order` and amount.

This script lists orders sitting in a paid-and-validated state, pulls each order's `order_payments` by `order_reference` (the resource has no direct `id_order` filter), and flags any pair of payments whose amounts match within a cent and whose `date_add` values are within about a minute of each other, the pattern that separates a duplicate write from a legitimate split payment. It never writes or deletes anything: the `order_payment` resource has no DELETE route in the core PrestaShop webservice, and removing the wrong row by hand risks corrupting `total_paid_real`. Flagged orders need a store admin to review and remove the extra row in Back Office > Orders, or via a backed up direct database delete plus a recalculation of `total_paid_real`.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/duplicate-order-payment-row/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export PAID_AND_LOGABLE_STATE_ID="12"   # the id_order_state that is both paid and logable
export DRY_RUN="true"                   # report-only either way, no delete route exists

python duplicate-order-payment-row/python/check_duplicate_payments.py
node   duplicate-order-payment-row/node/check-duplicate-payments.js
```

`find_duplicate_payments` is a pure function: given a list of `order_payments` rows for one order, it sorts by `date_add` and clusters any adjacent pair whose amounts match within a cent and whose timestamps are within 60 seconds of each other. Two payments of 49.99 twenty seconds apart are flagged; two payments of 49.99 and 25.00 are not; two payments of 49.99 three days apart are treated as a legitimate re-payment, not a duplicate. No network calls happen inside it, which is what makes it safe to test on its own.

## Test

```bash
pytest duplicate-order-payment-row/python
node --test duplicate-order-payment-row/node
```
