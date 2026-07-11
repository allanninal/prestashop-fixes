# Stock quantity corrupted on order status change

`OrderHistory::changeIdOrderState()` applies a signed stock delta for every order status transition it sees, with no memory of transitions it already applied. A duplicate `order_histories` row for the same target state (a webservice retry, an admin and API race) makes it apply the same delta again, doubling the decrement or increment. Reverting a status, such as Cancelled back to Awaiting payment, is treated as a brand new transition, so it adjusts stock again instead of restoring the value it had before. This is a documented PrestaShop defect (issues #22011 and #36024), not a store misconfiguration.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/stock-quantity-corrupted-on-status-change/

## Run it

```bash
export PRESTASHOP_URL="https://yourstore.example.com"
export PRESTASHOP_WS_KEY="YOURWEBSERVICEKEY"
export ORDER_IDS="1015,1042"
export DRY_RUN="true"

python stock-quantity-corrupted-on-status-change/python/reconcile_stock.py
node   stock-quantity-corrupted-on-status-change/node/reconcile-stock.js
```

`expected_stock_delta` is the pure decision function at the heart of this: given the flags of the state you left and the state you are entering, the order line quantity, the list of state ids already applied, and the candidate state id, it returns the exact stock delta PrestaShop should apply, treating an already-seen candidate state as a no-op. The script replays an order's full `order_histories` timeline through this function, sums the expected delta, and compares it against the live `stock_availables.quantity`.

This never blind-writes a corrected quantity. It reports one finding per order, product, and combination with the observed quantity, the expected delta, and any duplicate `order_histories` row ids, and only applies a compensating write when `DRY_RUN=false`, re-reading the stock resource immediately before writing so the correction is based on the latest value. Start with `DRY_RUN=true` and confirm the findings by hand first.

## Test

```bash
pytest stock-quantity-corrupted-on-status-change/python
node --test stock-quantity-corrupted-on-status-change/node
```
