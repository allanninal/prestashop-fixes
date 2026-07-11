# Refunded quantity exceeds the originally ordered quantity

PrestaShop stores `product_quantity` and `product_quantity_refunded` as independent unsigned columns on `order_detail`. Standard and partial refunds, issued through `IssueStandardRefundCommand` or `IssuePartialRefundCommand`, increment `product_quantity_refunded` without ever adjusting `product_quantity`, and nothing in the back office validates that the refunded count stays under the ordered count. If a line's quantity is later edited down by hand, or repeated partial refunds keep stacking against the same line outside the normal flow, `product_quantity_refunded` can end up bigger than `product_quantity`. Per PrestaShop/PrestaShop#39391 this can later throw `SQLSTATE[22003]: 1690 BIGINT UNSIGNED value is out of range in 'product_quantity - product_quantity_refunded'` when core code computes that subtraction for stock or shippable-quantity checks.

This job flags affected `order_detail` lines by default. It never overwrites `product_quantity_refunded` unless `DRY_RUN` is explicitly `false` and the order id is in an operator-confirmed `CONFIRM_ORDER_IDS` list, and even then it only clamps `product_quantity_refunded` down to `product_quantity`, re-sending the full `order_detail` resource body as PrestaShop's webservice requires on a `PUT`.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/refunded-quantity-exceeds-ordered/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DATE_FROM="2026-06-01"
export DATE_TO="2026-07-11"
export CONFIRM_ORDER_IDS=""   # comma-separated order ids, required alongside DRY_RUN=false to repair
export DRY_RUN="true"

python python/check_refund_overage.py
node   node/check-refund-overage.js
```

`find_refund_overage` (Python) / `findRefundOverage` (Node) is a pure function: given a list of already-fetched `order_detail` dicts, it flags any line where `product_quantity_refunded > product_quantity`, plus the secondary symptoms `product_quantity_return > product_quantity` and `product_quantity_reinjected > product_quantity_refunded`. It makes no network calls and needs no PrestaShop store to test. Findings are returned sorted by overage descending.

The script cross-checks `GET /api/order_slips` for each flagged order to see whether real credit slips corroborate the refunded quantity, which helps tell a legitimate high-refund history apart from raw data corruption. Start with `DRY_RUN=true` to review the report first; a corrective clamp only ever runs for order ids you explicitly confirm in `CONFIRM_ORDER_IDS`.

## Test

```bash
pytest refunded-quantity-exceeds-ordered/python
node --test refunded-quantity-exceeds-ordered/node
```
