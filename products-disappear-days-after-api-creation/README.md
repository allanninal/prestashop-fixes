# Products disappear from the storefront days after being added by API

Creating a product through the PrestaShop webservice API inserts the core `Product` object, but skips several side effects the back office Save form normally does: the `category_product` row gets no valid `position_in_category` (a read only, server computed field the API cannot set), the product never reaches the search index, and `active`, `visibility`, and `id_category_default` are frequently left at defaults because they were optional fields the caller forgot to send. The product row survives, but category listings, search, and related products filter on those missing pieces, so the product quietly drops out of navigation once cache expires or a reindex runs.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/products-disappear-days-after-api-creation/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export SCAN_MIN_ID="1"
export SCAN_MAX_ID="100"
export FALLBACK_CATEGORY_ID="2"
export DRY_RUN="true"

python products-disappear-days-after-api-creation/python/detect_and_repair_delisted_products.py
node   products-disappear-days-after-api-creation/node/detect-and-repair-delisted-products.js
```

`is_product_at_risk_of_delisting` is a pure function: a product is flagged when `active` is not `"1"`, when `visibility` is not `"both"` or `"catalog"`, when `id_category_default` is `0` or missing from its own `associations.categories`, when the category list is empty, or when stock is at zero and denying orders. The only write is a corrective `PUT` that resends the full product body with explicit category, visibility, and active fields, mirroring a back office Save, and it only fires when `DRY_RUN=false`. `position_in_category` is never set directly (it cannot be, it is read only), and the search index rebuild is never triggered by the script. It is not exposed over the webservice API, so that step is flagged for a human or a cron running `bin/console prestashop:index`. Start with `DRY_RUN=true` to review the flagged products and reasons first.

## Test

```bash
pytest products-disappear-days-after-api-creation/python
node --test products-disappear-days-after-api-creation/node
```
