# Per customer voucher limit ignored for guest checkouts sharing an email

PrestaShop's cart rule `quantity_per_user` check counts prior redemptions against `id_customer`, but guest checkout never reuses or merges an existing account by email. Every guest order creates a brand new customer record, so a repeat guest under the same email always gets a fresh `id_customer` with zero prior uses, and a "one per customer" voucher never blocks the second, third, or later order. This auditor groups redemptions by `(id_cart_rule, customer email)` instead of `(id_cart_rule, id_customer)` to find every voucher a guest overused.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/voucher-per-user-limit-ignored-for-guests/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"

python prestashop-fixes/voucher-per-user-limit-ignored-for-guests/python/audit_guest_voucher_reuse.py
node   prestashop-fixes/voucher-per-user-limit-ignored-for-guests/node/audit-guest-voucher-reuse.js
```

`find_overused_vouchers` is a pure function: it takes the already-fetched cart rules (limited to `quantity_per_user=1`), the `order_cart_rules` links, the orders (with `id_customer` and `current_state`), and the customers (with `email`), and returns every `(id_cart_rule, email)` pair whose redemption count exceeds `quantity_per_user`. Orders in an error or cancelled state (`PS_OS_ERROR`, `PS_OS_CANCELED`) are excluded before counting.

This script only reports. It never cancels, edits, or refunds an already-placed order. The only optional write is disabling further redemptions of a specific cart rule by setting `active=0`, and that only fires when `DRY_RUN=false` and a human has approved that `id_cart_rule`. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest prestashop-fixes/voucher-per-user-limit-ignored-for-guests/python
node --test prestashop-fixes/voucher-per-user-limit-ignored-for-guests/node
```
