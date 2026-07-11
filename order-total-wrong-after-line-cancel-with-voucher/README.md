# Order total wrong after cancelling a line item on an order with a voucher

Cancelling a product from a PrestaShop order in Back Office > Orders recalculates the remaining product line totals, but it does not re-derive `total_discounts` from the cart rules still attached to the order. A voucher computed as a percent-of-total, a fixed amount, or free shipping was calculated once against the original cart, so once a line is cancelled that original total no longer exists and `total_paid` / `total_paid_tax_incl` go stale. This job detects the mismatch, and only performs a corrective write under an explicit operator override.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/order-total-wrong-after-line-cancel-with-voucher/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export ORDER_IDS="123,124,125"
export DRY_RUN="true"   # start safe, only reports by default

python order-total-wrong-after-line-cancel-with-voucher/python/check_order_total_after_cancel.py
node   order-total-wrong-after-line-cancel-with-voucher/node/check-order-total-after-cancel.js
```

`recompute_order_total` (Python) / `recomputeOrderTotal` (Node) is a pure function: it takes the already-fetched `order_details`, `order_cart_rules`, `total_shipping`, and the order's reported `total_paid_tax_incl`, and returns the expected total, the delta, whether that delta exceeds a 2 cent tolerance, and whether the cart rule values have the invalid shape from PrestaShop issue #11059 (negative, or `value_tax_excl` summing higher than `value`).

By default the script only detects and reports, since an order's total may already be referenced by an invoice or an accounting export. Only when `DRY_RUN` is explicitly set to `false` does it perform a corrective `PUT /api/orders/{id}` with recomputed `total_discounts` / `total_paid` figures, always logging a before/after diff first. It never touches `current_state`; order state changes go only through `POST /api/order_histories`.

## Test

```bash
pytest order-total-wrong-after-line-cancel-with-voucher/python
node --test order-total-wrong-after-line-cancel-with-voucher/node
```
