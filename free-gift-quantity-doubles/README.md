# Free gift line quantity doubles when unrelated cart items are removed

An automatic free-gift cart rule (no voucher code, `gift_product` and `gift_product_attribute` set) is re-evaluated by `Cart::updateQty()` on every cart mutation. When an unrelated line item is removed, PrestaShop first drops the cart's applicable cart rules, recalculates them, and re-adds the gift row through the same "up" quantity operator used for normal products. Because the gift's existing `ps_cart_product` row (quantity 1, `is_gift`=1) has not been cleaned up yet at that point, the increment adds 1 to the existing row instead of inserting a fresh one, leaving the gift line at quantity 2 with no cart rule authorizing more than one free unit. This script pulls open carts and their rows, pulls active cart rules where `gift_product` is set, and reports every cart row matching a known gift product/attribute pair whose quantity is greater than 1. It never rewrites a cart automatically unless the gift row is confirmed pure (no separate non-gift row for the same product exists in that cart).

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/free-gift-quantity-doubles/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DATE_FROM="2026-07-01"
export DATE_TO="2026-07-11"
export DRY_RUN="true"

python free-gift-quantity-doubles/python/find_doubled_gift_lines.py
node   free-gift-quantity-doubles/node/find-doubled-gift-lines.js
```

`find_doubled_gift_lines` is a pure function: given a cart's rows (`id_product`, `id_product_attribute`, `quantity`) and the list of active cart rules that grant a gift (`gift_product` > 0), it builds a lookup of gift product/attribute pairs and flags any cart row matching a gift pair whose quantity is greater than 1, since a free-gift rule by definition never authorizes more than one free unit. Each finding also reports whether the granting rule's `code` is empty (`is_automatic`), matching the reported bug's no-code path. `is_pure_gift_row` is a second pure helper that confirms a cart row is safe to correct, only when no separate non-gift row for the same product exists in that cart. The only write this script can ever make is resetting a confirmed pure gift row's quantity to 1, and only when `DRY_RUN` is explicitly turned off. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest free-gift-quantity-doubles/python
node --test free-gift-quantity-doubles/node
```
