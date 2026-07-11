# Expired voucher still usable and left attached to orders

`CartRule::checkValidity()` checks a voucher's `date_to` expiry differently depending on an internal `alreadyInCart` flag. When a voucher is already sitting in the cart, that flag is true and the expiry check is effectively bypassed, so a code added before its expiry date stays valid through checkout even if the customer actually pays after `date_to` has passed (confirmed in PrestaShop/PrestaShop issues #26235 and #32303). Because the cart-to-order conversion copies the `cart_rule` association into `order_cart_rule` at payment time without re-validating dates, and nothing re-scans placed orders afterward, an expired discount can ride all the way into a paid order, leaving the discount shown on the order out of step with the amount actually charged (issue #34067).

This script lists still-open carts and recent orders, reads every attached voucher's `date_from`, `date_to`, and `active` flag from `cart_rules`, and flags any association where the record date (an order's `date_add`, or an open cart's `date_upd`) falls outside the voucher's validity window, or where an inactive rule is still referenced. This is a financial and discount-correctness issue, so the default action is to report every violation for manual finance review, never to auto-fix a paid order. A `DRY_RUN`-guarded repair is available for still-open, unpaid carts only, using a full resource PUT to `/api/carts/{id}` with the expired rule omitted from `associations.cart_rules`, since the webservice exposes no direct cart-cart_rule delete route. Already-paid orders are never edited.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/expired-voucher-still-applied/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export OPEN_CART_IDS="101,102,103"   # optional: still-open carts eligible for the guarded repair
export DRY_RUN="true"                # start safe, only reports and logs intended writes

python expired-voucher-still-applied/python/check_expired_voucher.py
node   expired-voucher-still-applied/node/check-expired-voucher.js
```

`is_voucher_expired_for_record` is a pure function: given a record date, a voucher's `date_from` and `date_to`, and its `active` flag, it returns true (a violation) when the rule is inactive but still referenced, or when the record date falls outside the inclusive `[date_from, date_to]` window. A record exactly at `date_to` is still valid; one second past it is flagged. No network calls happen inside it, which is what makes it safe to test on its own.

## Test

```bash
pytest expired-voucher-still-applied/python
node --test expired-voucher-still-applied/node
```
