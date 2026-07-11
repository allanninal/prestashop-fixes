# Negative stock quantities appear even with backorders disabled

PrestaShop only checks the per-product `out_of_stock` policy (0 deny, 1 allow, 2 use the global `PS_ORDER_OUT_OF_STOCK` setting) when a cart turns into an order. It never re-locks or re-verifies the `stock_available` row at final payment and validation, so two near-simultaneous orders, or an order racing a manual back-office edit or an import, can each decrement the same row past zero even with a deny policy. In multistore with Share available quantities on, the row is scoped to `id_shop_group`, so any shop in the group can decrement it, and combination or pack rows that were never correctly scoped can drift negative outside checkout entirely.

This script scans every shop, lists every negative `stock_available` row, resolves each product's real backorder policy (including the `out_of_stock=2` default-inheritance case), and reports only genuine violations. It never auto-corrects unless explicitly told to, because clamping a row could hide a real oversell that needs a refund or cancellation decision.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/negative-stock-despite-backorder-denied/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"

python negative-stock-despite-backorder-denied/python/reconcile_negative_stock.py
node   negative-stock-despite-backorder-denied/node/reconcile-negative-stock.js
```

By default the script only reports every row where quantity is negative and the resolved policy is deny. To also correct a row, run it with both `DRY_RUN=false` and an explicit `--clamp` flag:

```bash
DRY_RUN=false python negative-stock-despite-backorder-denied/python/reconcile_negative_stock.py --clamp
DRY_RUN=false node   negative-stock-despite-backorder-denied/node/reconcile-negative-stock.js --clamp
```

`classify_stock_violation` (Python) / `classifyStockViolation` (Node) is a pure function: given a quantity, the row's `out_of_stock` code, and the resolved global default, it returns `{policy, is_violation, clamp_to}`. A row is only a violation when the effective policy is deny and quantity is negative. When it does write, the script only ever sets `quantity` to `max(existing_quantity, 0)` and leaves `id_product`, `id_product_attribute`, the shop scoping, `depends_on_stock`, and `out_of_stock` untouched, so a repair can never accidentally reset the deny policy itself.

## Test

```bash
pytest negative-stock-despite-backorder-denied/python
node --test negative-stock-despite-backorder-denied/node
```
