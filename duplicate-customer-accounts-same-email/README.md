# Duplicate customer accounts created from the same email during guest checkout

PrestaShop enforces email uniqueness only in the front-office registration form's validation layer, not as a database constraint or a webservice-level check, and guest orders are exempt from that check entirely. Guest checkout creates a `ps_customer` row with `is_guest=1` for a given email. If the same visitor later checks out as guest again, converts that guest to a registered account (`CustomerCore`'s `transformGuestToCustomer`), or an admin or webservice call creates a customer with an email that already exists on a guest or non-guest row, PrestaShop inserts a second `ps_customer` row instead of merging into the existing one, because none of those code paths query for an existing email before inserting.

This script pulls every customer, groups the rows by lowercased and trimmed email in the client (the webservice has no GROUP BY or HAVING), and flags any email with more than one active (`deleted=0`) row. For each flagged email it fetches order counts per customer id so a human can see which row looks like the real primary account. It never merges anything automatically: reassigning addresses, orders, cart rules, and order history to one surviving `id_customer` is destructive and order-affecting. The only write it ever performs is a reversible soft-delete (`deleted=1`) of a duplicate row that has zero associated orders, and only when `DRY_RUN` is explicitly set to false.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/duplicate-customer-accounts-same-email/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"   # report-only; set to false to allow the zero-order soft-delete

python duplicate-customer-accounts-same-email/python/check_duplicate_customers.py
node   duplicate-customer-accounts-same-email/node/check-duplicate-customers.js
```

`pick_merge_action` is a pure function: given a list of customer rows sharing one normalized email, each carrying an `order_count`, it returns `None` when one or zero active rows remain, otherwise a merge-candidate report with `keep_id` (highest `order_count`, ties broken by non-guest over guest, then earliest `date_add`) and `duplicate_ids` for every other active row. No network calls happen inside it, which is what makes it safe to test on its own.

## Test

```bash
pip install requests pytest
pytest duplicate-customer-accounts-same-email/python

node --test duplicate-customer-accounts-same-email/node
```
