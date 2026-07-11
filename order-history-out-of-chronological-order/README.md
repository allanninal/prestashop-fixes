# Order history out of chronological order

`order_history.date_add` records write time, not the true business time of a state transition. When several state changes fire in quick succession, from `actionOrderStatusPostUpdate` hooks, retried webservice POSTs, or batch scripts replaying old orders, multiple `order_history` rows can land within the same second or out of order, so `orders.current_state` can end up disagreeing with the row that actually happened last. This script pulls each order's `current_state` and its full `order_histories`, sorts by `(date_add, id)` to find the true latest row, and flags any order where they disagree. It reports only, and never edits `current_state` or deletes/reorders `order_history` rows.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/order-history-out-of-chronological-order/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"

python order-history-out-of-chronological-order/python/chronology_audit.py
node   order-history-out-of-chronological-order/node/chronology-audit.js
```

`find_chronology_violation` is a pure function: it takes the list of `order_histories` rows and the order's `current_state`, sorts by `(date_add, id)` to find the true latest row (using `id` as the tiebreaker since `date_add` can collide at second granularity), and returns a violation only when the latest row's `id_order_state` disagrees with `current_state`, or when two rows share an identical `date_add` with different states. The script only ever reports. The one safe corrective write, appending a new `order_histories` row through the normal webservice path, only happens once a human confirms the correct state and `DRY_RUN` is set to `false`.

## Test

```bash
pytest order-history-out-of-chronological-order/python
node --test order-history-out-of-chronological-order/node
```
