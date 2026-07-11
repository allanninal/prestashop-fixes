# Multistore wrong country tax rate

Each shop in a PrestaShop multistore install has its own default country, but the tax engine is supposed to resolve the rate from the invoice address's `id_country`. When the address is incomplete, when an order arrives through pickup in store or the webservice without a full `id_address_invoice`, or when a price context falls back to the shop's own country, the `TaxManager` can silently use the shop's default country tax rule instead of the customer's real one. This script audits a range of orders, recomputes the expected tax from each order line's `id_tax_rules_group` and the invoice address's real country, and flags any order whose stored `total_paid_tax_incl` disagrees.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/multistore-wrong-country-tax-rate/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export ID_ORDER_START="1"
export ID_ORDER_END="200"
export DRY_RUN="true"

python multistore-wrong-country-tax-rate/python/audit_multistore_tax_rate.py
node   multistore-wrong-country-tax-rate/node/audit-multistore-tax-rate.js
```

`select_applicable_tax_rate` and `compute_expected_tax` are pure functions with no I/O. `select_applicable_tax_rate` always prefers the tax rule matching the customer's real `id_country` and never falls back to the shop's default country when a matching rule for the customer's country exists. The script only writes an audit report by default. A stored order total is a financial and legal figure, so it is never rewritten in place; the repair path only applies to orders still in an editable, unpaid `current_state`, requires `DRY_RUN=false`, and still requires an explicit human confirmation before any write. Start with `DRY_RUN=true` and review the report first.

## Test

```bash
pytest multistore-wrong-country-tax-rate/python
node --test multistore-wrong-country-tax-rate/node
```
