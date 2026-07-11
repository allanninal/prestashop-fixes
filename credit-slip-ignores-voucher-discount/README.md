# Credit slip amount ignores the original voucher discount

A voucher, or cart rule, reduces an order's total order-wide and is stored in order_cart_rules, linked to id_order, not to any single order_detail line. When a refund creates an order_slip, PrestaShop's core refund computation, and separately the PDF or HTML credit slip template, can each total the refund from a line's gross unit_price_tax_incl instead of the net amount the customer actually paid after the voucher. This job pulls each order's lines, its vouchers, and its issued credit slips, computes the expected refund with the discount properly prorated, and flags every order_slip whose amount overstates that expectation.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/credit-slip-ignores-voucher-discount/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export ORDER_ID_RANGE="1,50"
export DRY_RUN="true"

python credit-slip-ignores-voucher-discount/python/check_credit_slip_voucher.py
node   credit-slip-ignores-voucher-discount/node/check-credit-slip-voucher.js
```

`expected_refund_amount` is a pure function: it derives a discount_ratio from the voucher total and the order's pre-discount products total, prorates each refunded line by its own qty_refunded / qty_ordered, and applies the ratio before adding back any refunded shipping. `is_slip_overstated` compares that expected number against the amount already recorded on an order_slip, with a small rounding tolerance. This is unsafe to auto-fix, an order_slip is an accounting and legal document with no supported webservice endpoint to edit or delete it, so the script only ever reports, and only for orders that actually have a row in order_cart_rules. Every flagged row is a lead for accounting staff to correct manually through Orders, Credit Slips in the back office.

## Test

```bash
pytest credit-slip-ignores-voucher-discount/python
node --test credit-slip-ignores-voucher-discount/node
```
