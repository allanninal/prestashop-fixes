# Invoice number missing after an API status change

An order moved to Shipped through the PrestaShop webservice API updates `current_state` correctly, but no `order_invoice` row ever gets created, because that invoice is a side effect of `Order::setInvoice()`, which only fires when a new `order_histories` entry targets a state whose own `order_state.invoice` flag is 1 and `PS_INVOICE` is enabled for the shop. This job lists orders sitting on the invoice-eligible state you target, reads each order's existing `order_invoices`, and only ever generates the missing invoice for the safe, deterministic case: the state is genuinely eligible, invoicing is on, the order is valid, and no invoice row exists yet.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/invoice-number-missing-after-api-status-change/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export SHIPPED_STATE_ID="4"
export PS_INVOICE_ENABLED="true"
export DRY_RUN="true"

python python/backfill_missing_invoice.py
node   node/backfill-missing-invoice.js
```

`decide_invoice_repair` is a pure function: an order only gets `generate_invoice` when its current state is invoice-eligible, `PS_INVOICE` is on, the order is valid, and it has no `order_invoices` row yet. A state that was never flagged for invoicing, or a shop with invoicing off, is always skipped, never overridden. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest python
node --test node
```
