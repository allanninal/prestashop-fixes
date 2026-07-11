# Order carrier invalid after line edit

PrestaShop never removes a carrier row when you delete it in the back office, it only sets `carrier.deleted = 1`, so old orders keep pointing at an id that is now hidden from every UI and most webservice lists. Editing a carrier's settings is worse: PrestaShop duplicates the row under the same `id_reference` and hides the old one, so historic orders keep referencing a dead id. Editing an order's product lines or quantities can trigger a shipping recalculation that surfaces "The order carrier ID is invalid," and the back office then blocks editing that order's shipping and tracking at all. This job flags every order whose `id_carrier` has gone invalid.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/order-carrier-invalid-after-line-edit/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"
export DATE_UPD_FROM=""   # optional, e.g. 2026-06-01, to scope recently-edited orders

python order-carrier-invalid-after-line-edit/python/check_order_carrier.py
node   order-carrier-invalid-after-line-edit/node/check-order-carrier.js
```

`classify_order_carrier` is a pure function: it takes only the order's `id_carrier`, the set of valid non-deleted carrier ids, and the set of ids known to be soft-deleted, and returns `"zero"`, `"deleted"`, `"missing"`, or `"ok"`. The script reports every order that is not `"ok"` by default and never writes. Even with `DRY_RUN=false`, the only automated write it will attempt is repointing an order to a currently active carrier that shares the dead carrier's `id_reference`, followed by an `order_histories` entry. Every other case is left for a human to review.

## Test

```bash
pip install pytest && pytest order-carrier-invalid-after-line-edit/python
node --test order-carrier-invalid-after-line-edit/node
```
