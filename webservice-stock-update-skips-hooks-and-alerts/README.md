# Stock hooks and back in stock alerts never fire on webservice quantity updates

A webservice `PATCH` or `PUT` to `stock_availables` updates the quantity through a plain ORM save. It never calls the admin product controller or `StockAvailable` business logic that core hooks like `actionUpdateQuantity` are wired to, so the back in stock alert module, and any custom module listening on that hook, never runs. The number in the database is correct, nothing downstream of the hook ever finds out. This script keeps its own record of the last quantity seen per product, reads the real current quantity after any update, and flags a genuine restock notification only when an active, visible product moves from zero or below to a positive quantity.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/webservice-stock-update-skips-hooks-and-alerts/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export TRACKED_PRODUCT_IDS="12,34,56"
export DRY_RUN="true"

python webservice-stock-update-skips-hooks-and-alerts/python/detect_restock_alerts.py
node   webservice-stock-update-skips-hooks-and-alerts/node/detect-restock-alerts.js
```

`decide_restock_alert` is a pure function: it only recommends `flag_restock_alert` when the previous quantity it recorded was zero or below, the current quantity is positive, and the product is active and visible. Missing prior history, a missing `stock_availables` row, an inactive or hidden product, or any transition that is not zero-or-below to positive all resolve to `record_only`. The script never sends the notification itself; it hands the `id_product` to your own mailer, queue, or task tracker, and it always saves the freshly seen quantities so the next run compares against the right baseline. Start with `DRY_RUN=true` to review the flagged list first.

## Test

```bash
pytest webservice-stock-update-skips-hooks-and-alerts/python
node --test webservice-stock-update-skips-hooks-and-alerts/node
```
