# Order created in the wrong state when the amount paid does not match the total

Order validation writes whatever state a payment module or the back office asks for, along with the matching `order_histories` row, without independently re-checking that `total_paid_real` actually equals `total_paid`. A module that confirms an order on a partial payment, a currency rounding difference, or a manual state change in the back office can all leave an order sitting on a normal, paid-looking state while the two amount fields disagree underneath it.

This script pulls every order's `total_paid`, `total_paid_real`, and `current_state`, and flags any order where the two amounts disagree by more than a small rounding tolerance. It never edits `total_paid`, `total_paid_real`, or `current_state` directly. A confirmed repair posts a new `order_histories` row with a reviewed state, only when `DRY_RUN=false` and `CONFIRM_REPAIR=true`.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/order-state-mismatch-on-amount-paid/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"          # start safe, only reports by default
export CONFIRM_REPAIR="false"  # set true alongside DRY_RUN=false to actually apply a reviewed state
export REVIEWED_STATE="0"      # set to the id_order_state a human confirmed, before enabling repair

python order-state-mismatch-on-amount-paid/python/check_amount_mismatch.py
node   order-state-mismatch-on-amount-paid/node/check-amount-mismatch.js
```

`amount_mismatch` is a pure function: an order is flagged only when `total_paid_real` disagrees with `total_paid` by more than a small rounding tolerance, and the result also reports whether the order's current state is one PrestaShop itself flags as paid, which is the more urgent case. No network calls happen inside it, which is what makes it safe to test on its own. Start with `DRY_RUN=true` to review the flagged list before ever writing anything.

## Test

```bash
pytest order-state-mismatch-on-amount-paid/python
node --test order-state-mismatch-on-amount-paid/node
```
