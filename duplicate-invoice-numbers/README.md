# Duplicate invoice numbers issued across different orders

PrestaShop assigns invoice numbers in `Order::setInvoice()` and `setLastInvoiceNumber()` with a non-atomic read then write: it runs a query equivalent to `SELECT MAX(number)+1 FROM ps_order_invoice` and writes that computed value into the new invoice row, instead of using a real atomic counter such as an auto-increment column or a `SELECT ... FOR UPDATE` inside a transaction. Under concurrent checkout load, two order-validation requests can both read the same current `MAX` before either writes back, so both compute and save the identical number for two different orders. This job pulls recent `order_invoices`, groups them by `number`, confirms each collision involves two genuinely different orders, and reports every pair for a human to review. It never renumbers or writes anything, since invoice numbers are fiscal and legal documents.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/duplicate-invoice-numbers/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export INVOICE_DATE_START="2026-07-01"
export INVOICE_DATE_END="2026-07-11"
export DRY_RUN="true"

python duplicate-invoice-numbers/python/check_duplicate_invoice_numbers.py
node   duplicate-invoice-numbers/node/check-duplicate-invoice-numbers.js
```

`find_duplicate_invoice_numbers` is a pure function: it groups invoice records by `number` and returns a collision for every number linked to more than one distinct `id_order`. A single order fetched twice keeps the same `id_order`, so it is never flagged as a collision. The script only ever reads and logs a report; it never calls `PUT`/`PATCH` on `order_invoices` and never renumbers an invoice. Flagged pairs need an accountant or admin to decide which order keeps the number and issue a corrective reissued invoice for the other through the normal Back Office generate invoice action.

## Test

```bash
pytest duplicate-invoice-numbers/python
node --test duplicate-invoice-numbers/node
```
