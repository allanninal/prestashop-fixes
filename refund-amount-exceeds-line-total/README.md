# Partial refund accepted for more than the original line amount

PrestaShop's partial-refund flow, whether through the back office Order Refund form, the actionOrderSlipAdd hook, or a direct write through the webservice, computes the refunded amount from whatever the operator or API caller submits. There is no consistent server-side cap comparing that number against the order line's own product_quantity and total_price_tax_incl, so a client that skips the back-office form can post a refund that exceeds the line total with no rejection. This job pulls each order's order_detail rows, computes the refunded amount per line, and flags every line where the refunded quantity or amount is bigger than the line ever was.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/refund-amount-exceeds-line-total/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export ORDER_ID_RANGE="1,50"
export DRY_RUN="true"

python refund-amount-exceeds-line-total/python/check_refund_overage.py
node   refund-amount-exceeds-line-total/node/check-refund-overage.js
```

`is_refund_overage` is a pure function: it compares `product_quantity_refunded` against `product_quantity` and the refunded amount against `total_price_tax_incl`, with a small epsilon for rounding, and returns whether either one overshoots and by how much. A refund is already a financial transaction reflected in a credit note and possibly reconciled with a payment gateway, so this is unsafe to auto-fix. The script only ever reports; it never mutates an `order_detail` row or an `order_slip`. `would_new_refund_overshoot` is a separate preventive guard meant to be called before a new refund is created, rejecting a request that would exceed the line's remaining unrefunded balance, never editing history.

## Test

```bash
pytest refund-amount-exceeds-line-total/python
node --test refund-amount-exceeds-line-total/node
```
