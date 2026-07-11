# Single use voucher redeemed more than its allowed quantity

`CartRule::checkValidity` reads a voucher's remaining `quantity` and a customer's prior `quantity_per_user` usage at apply time and again at order validation, but those reads and writes are not wrapped in a locking transaction. Under concurrent checkouts, two customers can each pass the "quantity remaining greater than zero" check before either order's validation step decrements the cart rule's used count, so a single-use voucher can end up referenced by more than one paid order. `quantity_per_user` is also checked against `id_customer`, so guest checkouts can bypass the per-user cap. This script pulls the cart rule's definition, pulls every valid, paid order that used it through `order_cart_rules`, counts total uses against `quantity` and per-customer uses against `quantity_per_user`, and reports every overused voucher with the offending order ids for manual review. It never cancels, edits, or refunds an order that already used the voucher.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/voucher-redeemed-beyond-quantity-limit/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export CART_RULE_ID="42"
export DRY_RUN="true"

python voucher-redeemed-beyond-quantity-limit/python/audit_voucher_overuse.py
node   voucher-redeemed-beyond-quantity-limit/node/audit-voucher-overuse.js
```

`find_voucher_overuse` is a pure function: given the cart rule (`quantity`, `quantity_per_user`) and the list of valid orders already using it, it counts total uses and groups them by `id_customer`, then flags the voucher if either the overall `quantity` or any customer's `quantity_per_user` is exceeded. It returns a full report with the offending order ids and per-user violation counts, or `None` when the voucher is within its limits. The only write this script can ever make is disabling further use of an already-overused voucher by setting `quantity` to 0, and only when `DRY_RUN` is explicitly turned off. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest voucher-redeemed-beyond-quantity-limit/python
node --test voucher-redeemed-beyond-quantity-limit/node
```
