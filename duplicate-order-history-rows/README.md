# Duplicate order history rows

`Order::setCurrentState()`, called directly in the back office or through `Order::setWsCurrentState()` when the webservice PUTs an order with `current_state` set, historically ran its full body every time it was invoked: insert an `order_history` row, send the order state's email, fire the related hooks, without first checking whether the order already had the requested state. A retried webhook, a payment module firing its IPN handler twice, or a webservice client blindly PUTting the same state can insert the same `order_history` row twice, and can resend the customer email. This script reports the duplicate ids by default and only deletes them, never the first row of a run, with an explicit `DRY_RUN=false`.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/duplicate-order-history-rows/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"

python duplicate-order-history-rows/python/duplicate_history_cleanup.py
node   duplicate-order-history-rows/node/duplicate-history-cleanup.js
```

`find_duplicate_history_ids` is a pure function: it sorts an order's `order_histories` rows by `(date_add, id)`, then flags any row whose `id_order_state` matches the row directly before it. The first row of every run is always kept, only later repeats are flagged, and a state the order legitimately revisits later (with a different state in between) is never flagged. Start with `DRY_RUN=true` to review the list first, and only the flagged duplicate ids are ever deleted, never the order's own `current_state` field.

## Test

```bash
pytest duplicate-order-history-rows/python
node --test duplicate-order-history-rows/node
```
