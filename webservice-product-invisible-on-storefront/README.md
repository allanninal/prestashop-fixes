# Product created via webservice is invisible on the storefront

A product added through the PrestaShop webservice can show active in the back office grid yet never appear on the storefront. The full admin product save wires up `category_product` links, shop associations, and search index rows as side effects of the whole controller save chain. The webservice `Product::add()`/`update()` path only writes what the submitted resource body explicitly includes, so a payload missing `associations.categories` or `associations.shops` leaves the product active but structurally invisible. This script lists recently created active products, checks their associations and visibility, and merges the missing links back onto the existing resource, never blind-overwriting it.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/webservice-product-invisible-on-storefront/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export EXPECTED_SHOP_IDS="1"
export DRY_RUN="true"

python webservice-product-invisible-on-storefront/python/repair_invisible_product.py
node   webservice-product-invisible-on-storefront/node/repair-invisible-product.js
```

`decide_product_repair` is a pure function: inactive products are always `ok` and left alone. An active product is flagged `needs_repair` when its `associations.categories` is empty or missing `id_category_default`, when `associations.shops` is empty or missing every expected shop id, or when `visibility` is `none`, and the function builds the merge patch for exactly those gaps. A product whose `id_category_default` itself is not in the caller's list of valid category ids is always `unrepairable`, since guessing a replacement category could mis-file the product, so it is only ever reported for a human to pick a valid category. The only sanctioned write is a `PUT /api/products/{id}` carrying the full existing resource merged with the missing associations; the script re-GETs afterward and only counts a product as repaired once the associations actually confirm it. Start with `DRY_RUN=true` to review the computed diffs first.

## Test

```bash
pytest webservice-product-invisible-on-storefront/python
node --test webservice-product-invisible-on-storefront/node
```
