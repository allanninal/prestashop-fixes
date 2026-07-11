# Orders created via webservice land in a payment error state

An order POSTed to `/api/orders` comes back fine, but the order itself lands on "Payment error" instead of the state you expected. PrestaShop's order validation compares the cart's computed total against the `amount_paid` the caller supplied, and forces the order into `Configuration::PS_OS_ERROR` whenever the two disagree. Webservice integrations often omit or miscalculate `total_shipping` or `total_paid_real`, since the API never computes shipping or tax for you, so the number sent and the number the order actually settles on drift apart. This reconciler lists orders stuck in that state, cross-checks each against its `order_payments` row and the recomputed cart total, and repairs only the safe, deterministic case where the order's own total is already correct but the payment row disagrees with it. Anything where the order total itself is wrong is flagged for manual review, never auto-corrected.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/webservice-order-payment-error-mismatch/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export ERROR_STATE_ID="8"
export PAID_STATE_ID="2"
export DRY_RUN="true"

python webservice-order-payment-error-mismatch/python/reconcile_payment_error.py
node   webservice-order-payment-error-mismatch/node/reconcile-payment-error.js
```

`decide_order_payment_repair` (Python) / `decideOrderPaymentRepair` (Node) is a pure function: it reproduces PrestaShop's own comparison, `number_format(order.total_paid, 2) != number_format(order_payments.amount, 2)`, and only recommends a write when the order's own `total_paid` already matches the recomputed cart total but the payment row does not. If `total_paid` itself diverges from the cart total, or there is no `order_payments` row to compare, the order is flagged for manual review instead. The only writes are a `PUT` to `order_payments` correcting `amount`, and a `POST` to `order_histories` to advance the state, `current_state` is never edited directly. Start with `DRY_RUN=true` to review the intended changes before anything is written.

## Test

```bash
pytest webservice-order-payment-error-mismatch/python
node --test webservice-order-payment-error-mismatch/node
```
