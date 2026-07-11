# Specific price priority wrong

PrestaShop resolves a product's effective price by scanning every `specific_price` row (and `specific_price_rule` catalog rule) that matches the request context and picking the first one that fits a fixed priority order: Shop, then Currency, then Country, then Group. It does not compute every matching rule and choose the numerically lowest resulting price. Because "All Groups" and generic country or currency wildcards sit in a priority position that is not strictly "more specific wins," a broader rule can be selected over a narrower, better rule the customer actually qualifies for. This script independently recomputes the best legitimate price for a given product and customer context and flags every case where the store served something worse.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/specific-price-priority-wrong/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"
export CONFIRMED_STALE_SPECIFIC_PRICE_ID=""   # only set once an operator has confirmed a specific row is stale

python specific-price-priority-wrong/python/check_specific_price_priority.py
node   specific-price-priority-wrong/node/check-specific-price-priority.js
```

`resolveBestSpecificPrice` (Python: `resolve_best_specific_price`) is a pure function: given a base price, the candidate `specific_price` rows, and the customer's real context (group ids, currency, country, customer id, quantity, and the current time), it filters to the rows that actually match and returns the rule producing the numerically lowest price, the price the customer legitimately qualifies for. `findPriceMismatch` compares that recomputed price to whatever PrestaShop's own resolution actually returned, flagging anything worse by more than a currency-rounding epsilon.

This is a core pricing-engine priority defect, not a bad data row, so the default action is to flag every mismatch for manual review, never a bulk write. The only write path, `repair_confirmed_stale_row` / `repairConfirmedStaleRow`, targets a single specific_price id that an operator has explicitly confirmed as superseded, and only runs when `DRY_RUN` is set to `false` and `CONFIRMED_STALE_SPECIFIC_PRICE_ID` is set. Start with `DRY_RUN=true` to review the flagged list first.

## Test

```bash
pytest specific-price-priority-wrong/python
node --test specific-price-priority-wrong/node
```
