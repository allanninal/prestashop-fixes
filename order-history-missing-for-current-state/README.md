# Order history missing for the order's current state

PrestaShop keeps two representations of an order's status in sync by convention, not by a database constraint: the denormalized `orders.current_state` column, and the append-only `order_history` (`ps_order_history`) audit trail that is supposed to gain a new row every time the state changes. When `OrderHistory::changeIdOrderState()` or `addWithemail()` is interrupted, a crash during order creation, a module or webservice call that writes `current_state` directly, or a broken insert like the `id_employee` mismatch seen after the 8.1.0 upgrade, the order ends up pointing at a state that has no matching history record.

This script pulls every order's `current_state`, pulls its `order_history` rows, and flags any order where history is empty or the latest row's `id_order_state` does not match. It never edits `orders.current_state` directly. A confirmed repair posts a synthetic `order_history` row tagged `id_employee=0`, only when `DRY_RUN=false` and `CONFIRM_REPAIR=true`.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/order-history-missing-for-current-state/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"          # start safe, only reports by default
export CONFIRM_REPAIR="false"  # set true alongside DRY_RUN=false to actually backfill

python order-history-missing-for-current-state/python/check_order_history.py
node   order-history-missing-for-current-state/node/check-order-history.js
```

`needs_history_backfill` is a pure function: an order is flagged only when its history is empty (`no_history`) or the most recent history row's state does not match `current_state` (`state_mismatch`). No network calls happen inside it, which is what makes it safe to test on its own. Start with `DRY_RUN=true` to review the flagged list before ever writing anything.

## Test

```bash
pytest order-history-missing-for-current-state/python
node --test order-history-missing-for-current-state/node
```
