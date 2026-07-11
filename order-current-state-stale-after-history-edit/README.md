# Order current_state stale after history edit

PrestaShop only keeps `orders.current_state` in sync with `order_history` inside `Order::setCurrentState()` and `OrderHistory::addWithemail()`, which insert a history row and write that same state into `current_state` in one call. If a history row is deleted or edited directly, by a bad module, a GDPR or cleanup script, a manual database fix, or an admin removing a wrongly-added status line, that write path is bypassed and `current_state` silently goes stale. This job finds every order where the stored pointer disagrees with what its own history now shows as most recent, and repairs only the pointer, never the history.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/order-current-state-stale-after-history-edit/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"

python order-current-state-stale-after-history-edit/python/fix_stale_current_state.py
node   order-current-state-stale-after-history-edit/node/fix-stale-current-state.js
```

`compute_correct_current_state` is a pure function: given an order's `order_histories` rows, it returns the `id_order_state` of the row with the most recent `date_add`, breaking ties by the highest `id`, or `None` when the list is empty. An empty result means "flag this order, do not repair it," since there is no history to recompute from. The only write is a `PUT` on the order's `current_state` field; the script never inserts a new `order_histories` row, so it never triggers a customer notification email. Start with `DRY_RUN=true` to review the list of stale pointers first.

## Test

```bash
pytest order-current-state-stale-after-history-edit/python
node --test order-current-state-stale-after-history-edit/node
```
