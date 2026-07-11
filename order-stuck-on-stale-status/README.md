# Order stuck on stale status

PrestaShop keeps order status in two places: the denormalized `current_state` column on the order, and the append-only `order_history` table that core keeps in step through `Order::setCurrentState()`. A webservice PUT to the `orders` resource can set `current_state` in the payload without reliably calling that method, so `order_history` never gets a new row and the order looks frozen on the same status for an implausible number of days.

This script polls in-progress orders, builds the terminal state set from `order_states` instead of hardcoding it, and flags an order as stuck only when its cached `current_state` agrees with the newest `order_histories` row and both are older than a stale threshold. That distinguishes a genuinely stuck order from a hidden desync where the history table advanced but the cached `current_state` did not. Flag-and-report is the default. Repair only ever posts a corrective `order_histories` row for a specific, human-approved order, never a direct write to `current_state`.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/order-stuck-on-stale-status/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export STALE_DAYS_THRESHOLD="5"
export IN_PROGRESS_STATE_IDS="1,2,3"
export DRY_RUN="true"

# Only used when DRY_RUN=false, to approve one specific repair:
export APPROVED_ORDER_ID=""
export APPROVED_ORDER_STATE_ID=""
export PRESTASHOP_BOT_EMPLOYEE_ID="0"

python order-stuck-on-stale-status/python/order_stuck_on_stale_status.py
node   order-stuck-on-stale-status/node/order-stuck-on-stale-status.js
```

`is_order_stuck` is a pure function (the current time is passed in): an order is flagged only when its state is not terminal, it has been idle longer than the threshold, and the newest `order_histories` row agrees with the cached `current_state`. Start with `DRY_RUN=true` to review the list first, and only repair a specific order once an operator has separately confirmed its real state.

## Test

```bash
pytest order-stuck-on-stale-status/python
node --test order-stuck-on-stale-status/node
```
