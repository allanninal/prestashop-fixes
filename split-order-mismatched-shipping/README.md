# Split orders show mismatched totals and wrong shipping cost

When a cart contains products assigned to different carriers, or products a carrier excludes by weight or zone rules, PrestaShop's checkout splits the cart into multiple orders that share the same reference but each get their own row in order_carriers. The split logic frequently mis-assigns which order gets which carrier row: one split order ends up with no id_carrier and 0.00 shipping cost while another gets an extra, duplicated shipping charge, so total_paid summed across the split orders no longer equals the original cart total. This job pulls every order sharing a reference, cross-checks each one's id_carrier and total_shipping_tax_incl against the authoritative order_carriers rows, and flags anything that disagrees.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/split-order-mismatched-shipping/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export REFERENCES="ABCDEFGHI,JKLMNOPQR"
export DRY_RUN="true"

python split-order-mismatched-shipping/python/check_split_shipping.py
node   split-order-mismatched-shipping/node/check-split-shipping.js
```

`find_shipping_mismatches` is a pure function: it groups order_carriers by id_order and compares each order's own id_carrier and total_shipping_tax_incl against its matching order_carriers row, returning a reason for every disagreement. `reconcile_reference_total` is a second pure function that sums total_paid_tax_incl across every order sharing a reference and compares it against an independently computed expected total, catching cross-order mismatches that no single order reveals on its own.

This is mostly unsafe to auto-fix, since the true carrier-to-product mapping is not always reconstructable once the bug has already miscomputed it. The script reports every mismatch by default and only attempts a corrective write for the narrow `shipping_cost_mismatch` case, where order_carriers already holds a single unambiguous row for that order, copying its values onto the order with a PUT and then re-applying the current state through `order_histories` to force PrestaShop to recalculate. A missing carrier row entirely, or a duplicated charge with no matching order_carriers row, is always left for a human to reconcile or refund.

## Test

```bash
pytest split-order-mismatched-shipping/python
node --test split-order-mismatched-shipping/node
```
