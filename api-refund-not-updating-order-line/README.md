# Refund created via API does not update the order's refunded quantity

Creating a credit slip through `POST /api/order_slip` only inserts rows into `order_slip` and `order_slip_detail`. It never runs the back office refund logic in `OrderSlip::create()` or `AdminOrdersController`, which is what actually recalculates and writes `order_detail.product_quantity_refunded`, the refund totals, and the related stock movement. So a credit slip can exist while the order line still reports its old refunded quantity.

This script sums `product_quantity` from every `order_slip_detail` row per `id_order_detail` to get the expected refunded quantity, compares it against the stored `product_quantity_refunded`, and only writes the corrected value when `DRY_RUN` is explicitly false. A negative delta (stored higher than expected) is always flagged for a human, never auto-corrected.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/api-refund-not-updating-order-line/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export ORDER_IDS="101,102,103"
export DRY_RUN="true"

python python/fix_api_refund_quantity.py
node   node/fix-api-refund-quantity.js
```

`compute_refund_delta` is a pure function: it sums the credit slip quantities to get the expected refunded quantity and compares it against the stored value. `needs_repair` is true only when the credit slips claim more refunded units than the order line shows, the exact symptom this script exists to fix. `needs_review` is true when the stored value is already higher than the credit slips justify, which is always left for a human rather than corrected automatically. The script also skips a repair when the order has no `order_histories` rows, since that means the order's state does not yet look consistent with a refund. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest python/
node --test node/
```
