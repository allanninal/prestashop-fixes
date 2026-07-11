# Order created via webservice with no current state set at all

A POST to the PrestaShop `orders` webservice resource does not run through
`OrderHistory::changeIdOrderState()`, the only code path that both writes an
`order_history` row and updates the denormalized `orders.current_state` column. A
client that omits `current_state` or sets it directly on the order object gets an
order stored with `current_state` at 0 (or an unapplied value) and zero rows in
`order_history`. This job lists orders with `current_state=0`, confirms each one is
truly stateless by checking that `order_histories` is empty for it, resolves a safe
state from the order's own payment facts, and repairs it with a POST to
`order_histories`, the same call the back office makes internally. It never writes
`current_state` directly onto an order.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/webservice-order-created-without-state/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"

python prestashop-fixes/webservice-order-created-without-state/python/backfill_stateless_orders.py
node   prestashop-fixes/webservice-order-created-without-state/node/backfill-stateless-orders.js
```

`resolve_backfill_state` is a pure function (no network calls): given an order's
plain fields and the shop's `order_states`, it returns the `id_order_state` to
backfill, or `None`/`null` when no safe decision can be made. It returns `None` if
the order already has a `current_state` set (the caller is expected to have already
confirmed no `order_histories` rows exist). Otherwise it resolves to a single
"payment accepted"-style logable, non-hidden state when the order is fully or over
paid, or to the lowest-id "awaiting payment"-style logable, non-hidden state
otherwise. Anything ambiguous, such as zero or multiple matching states, returns
`None` to force a manual flag instead of guessing.

Start with `DRY_RUN=true` to review the list of `(id_order, resolved_state_id)`
pairs the script would create before it writes anything.

## Test

```bash
pytest prestashop-fixes/webservice-order-created-without-state/python
node --test prestashop-fixes/webservice-order-created-without-state/node
```
