# Free shipping voucher fails to zero out the shipping cost

PrestaShop stores a cart rule's free shipping benefit as a boolean flag, `free_shipping`, on `cart_rule` and `cart_rule_action`. That flag only turns into an actual zero shipping cost when the normal cart totals pipeline, `Cart::getTotalShippingCost` and `getPackageShippingCost`, runs and the rule passes every restriction check: carrier restriction, minimum amount, product or category or group scoping, and combinability with other applied rules. If the voucher is combined with a non-combinable rule, the customer's carrier is not in the allowed list, or the order was written through the webservice, a bulk import, a POS sync, or a custom checkout instead of Cart totals recalculation, the flag never reaches `total_shipping` and `total_shipping_tax_incl`, and the carrier's full cost stays on the order.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/free-shipping-voucher-not-applied/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export ORDER_IDS="101,102,103"
export DRY_RUN="true"

python python/check_free_shipping.py
node   node/check-free-shipping.js
```

`decide_free_shipping_violation` is a pure function: an order and cart rule pairing is flagged only when the rule is active with `free_shipping` set, the order date falls inside the rule's validity window, the order's carrier is allowed by `carrier_restriction` (or the rule has no restriction), and the order's `total_shipping_tax_incl` is still greater than `0.00`. A legitimate carrier mismatch correctly returns no violation.

The default action is to report every violation, since recomputing order totals has to reuse PrestaShop's own tax and shipping rules rather than a script blindly zeroing a field. Start with `DRY_RUN=true` to review the list first. Only turn it off after confirming through `order_carriers` and `order_cart_rules` that the free shipping rule was genuinely valid for that order's carrier.

## Test

```bash
pytest python
node --test node
```
