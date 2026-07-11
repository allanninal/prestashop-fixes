# Reserved stock quantity drifts from actual pending orders

`stock_available.reserved_quantity` is a running counter that PrestaShop updates only as a side effect of `order_histories` inserts, not a live query against currently open orders. When an order is cancelled, refunded, or its state changes outside the normal flow (a bulk edit, a direct database write, a custom module, or a webservice call that skips `order_histories`), the decrement step is skipped and the counter never returns to zero. This script recomputes the expected reserved quantity from real open orders, diffs it against what the API reports, and repairs any drift by reposting the order's own current state to `order_histories`, which re-triggers PrestaShop's native `StockManager` recalculation. It never writes `reserved_quantity` or `physical_quantity` directly.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/reserved-quantity-drift/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"

python reserved-quantity-drift/python/reserved_quantity_drift.py
node   reserved-quantity-drift/node/reserved-quantity-drift.js
```

`compute_reserved_drift` (Python) / `computeReservedDrift` (Node) is a pure function: it filters open order lines to logable order states, sums quantity minus refunded quantity per product and combination clipped at zero, joins that against the stock rows the API reports, and returns only the rows where expected and actual reserved quantity disagree, along with the signed drift. Start with `DRY_RUN=true` to review the list before anything is resynced.

## Test

```bash
pytest reserved-quantity-drift/python
node --test reserved-quantity-drift/node
```
