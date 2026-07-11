# Negative quantities recorded on backorder paid orders

PrestaShop decrements `ps_stock_available.quantity` at order validation without a transactional row lock tied to the final payment confirmation. When a product allows backorders, or stock enforcement is momentarily bypassed, concurrent checkouts or an order passing through a backorder paid state can each subtract from an already-zero or already-reserved stock line, driving `quantity` below zero with nothing in core to self heal it. This reconciler pulls every negative `stock_availables` row, cross-references the orders and order states that plausibly caused it, and classifies each row as no correction needed, safe to clamp to zero, or needing a human to reconcile stock or trigger a reorder.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/negative-quantity-on-backorder-orders/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"

python negative-quantity-on-backorder-orders/python/negative_quantity_backorder.py
node   negative-quantity-on-backorder-orders/node/negative-quantity-backorder.js
```

`clamp_negative_stock` is a pure function: a row is only ever clamped to zero when its quantity is negative, `depends_on_stock` is true, and either backorders should have been denied or there is no genuine open backorder-paid order to justify the deficit. Rows that represent real, still-open backorder demand are flagged for manual review and are never written through the API. Start with `DRY_RUN=true` to review the split between clamp and flag before writing anything.

## Test

```bash
pip install pytest requests
pytest negative-quantity-on-backorder-orders/python

node --test negative-quantity-on-backorder-orders/node
```
