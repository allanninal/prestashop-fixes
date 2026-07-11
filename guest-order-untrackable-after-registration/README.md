# Guest order untrackable after registration

A guest checkout creates a customers row with `is_guest=1`, and the order's `id_customer` points at that row. When the same person later registers a full account with the identical email, PrestaShop does not always detect the existing guest record and convert it in place. It can instead create a second, separate customers row, leaving the old order's `id_customer` still pointing at the original guest id, so the order never appears in the new account's order history. This job pulls guest customers and registered customers, matches them by normalized email, lists every guest order that got left behind, and reports it for a human to review.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/guest-order-untrackable-after-registration/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"

python guest-order-untrackable-after-registration/python/find_orphaned_orders.py
node   guest-order-untrackable-after-registration/node/find-orphaned-orders.js
```

`find_orphaned_guest_orders` is a pure function (no I/O, no network): given already-fetched guest customers, real customers, and orders, it groups both customer lists by lowercased and trimmed email, matches emails present in both groups, and returns one `{id_order, current_id_customer, target_id_customer, email}` entry per orphaned order. With `DRY_RUN=true` (the default) the script only logs the planned relink and never writes. Relinking an order is destructive to order data and PrestaShop's own core has open bugs in this area, so treat any `DRY_RUN=false` run as a human-approved batch, and never merge or delete the guest customer row automatically.

## Test

```bash
pip install pytest
pytest guest-order-untrackable-after-registration/python

node --test guest-order-untrackable-after-registration/node
```
