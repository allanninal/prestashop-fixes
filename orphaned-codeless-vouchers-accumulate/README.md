# Orphaned codeless vouchers accumulate

System generated PrestaShop cart rules created with no `code` auto-apply to qualifying carts (free shipping over a threshold, loyalty or referral discounts through `CartRule::autoAddToCart`). Once such a rule's `quantity` hits zero, its `date_to` expires, or it gets deactivated, it becomes permanently unusable, but the back office has never had a reliable delete affordance for a codeless rule, so dead rows just pile up in `cart_rule` and clutter admin listings and reports.

This reporter lists every cart rule, flags the codeless ones that are exhausted, expired, or disabled, cross-checks `order_cart_rules` to rule out a rule still referenced by a real historical order, and writes a CSV report. It never deletes anything unless you explicitly confirm specific ids after reviewing the report.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/orphaned-codeless-vouchers-accumulate/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"                      # start safe, only writes a report, never deletes
export REPORT_PATH="orphaned_vouchers_report.csv"
export CONFIRMED_DELETE_IDS=""             # e.g. "12,45,88" after you review the report and set DRY_RUN=false

python orphaned-codeless-vouchers-accumulate/python/report_orphaned_vouchers.py
node   orphaned-codeless-vouchers-accumulate/node/report-orphaned-vouchers.js
```

`is_orphaned_codeless_voucher` (Python) / `isOrphanedCodelessVoucher` (Node) is a pure function with no I/O: it returns true only when a rule's `code` is blank and it is exhausted (`quantity <= 0`), expired (`date_to` before today), or disabled (`active` is false). A rule with any code is never flagged, no matter its quantity or dates. The only write the script can ever make is deleting a cart rule id you explicitly listed in `CONFIRMED_DELETE_IDS` after reviewing the report, and even then only after re-confirming `order_cart_rules` is empty for that id.

## Test

```bash
pytest orphaned-codeless-vouchers-accumulate/python
node --test orphaned-codeless-vouchers-accumulate/node
```
