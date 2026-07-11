# Duplicate product reference or SKU allowed across different products

`ps_product.reference` has no unique, or even indexed-unique, database constraint, and neither the back office product form, the Duplicate product action, nor the Webservice API layer check other rows before saving. So a new product, or a duplicated one, can be saved with a reference or SKU that already exists on a different `id_product`, and it stays that way until someone notices. This job pulls the catalog through the Webservice API, groups products (and optionally combinations) by a normalized reference, skips blank references, and reports every reference used by more than one product id as a collision for a human to review.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/duplicate-product-reference-sku/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export DRY_RUN="true"
export RESOLUTION_MAP="{}"   # e.g. {"812": "SKU-123-DUP2"} once a human approves a rename

python duplicate-product-reference-sku/python/find_reference_collisions.py
node   duplicate-product-reference-sku/node/find-reference-collisions.js
```

`find_reference_collisions` is a pure function: it trims each reference, skips blank ones, groups products by that string, and returns only the groups where two or more distinct product ids share it. The script only ever reads and reports by default. It writes a renamed reference only when `DRY_RUN=false` and `RESOLUTION_MAP` names the exact product id and new reference an operator approved, using `GET` to fetch the current full product body and `PUT` to save it back with only `reference` changed. It never merges or deletes products.

## Test

```bash
pytest duplicate-product-reference-sku/python
node --test duplicate-product-reference-sku/node
```
