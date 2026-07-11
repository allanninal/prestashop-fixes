# Product missing default category after category deletion

Deleting a category in the PrestaShop back office only reassigns a product's categories when the deletion would leave the product with zero categories at all. It never checks whether the deleted category was that product's *default* category while the product still has other valid categories, so `id_category_default` keeps pointing at a category id that no longer exists in `ps_category`. This job builds the set of valid category ids, walks every product, and runs a pure decision function that picks a replacement default from the product's own remaining valid categories, falling back to the shop's root category. It logs every proposed change; a corrective PUT is only sent when explicitly allowed.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/product-missing-default-category-after-deletion/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export FALLBACK_ROOT_CATEGORY_ID="2"
export DRY_RUN="true"

python product-missing-default-category-after-deletion/python/fix_default_category.py
node   product-missing-default-category-after-deletion/node/fix-default-category.js
```

`choose_valid_default_category` is a pure function: it returns `action: "none"` when the product's current `id_category_default` is already valid, `action: "reassign"` with a replacement id picked from the product's own remaining valid categories (or the fallback root category when none are left), or `action: "flag_manual"` when neither the product's categories nor the fallback resolve to anything valid. The only write is a full `PUT` of the product resource with the new `id_category_default`, and it only runs when `DRY_RUN=false`. Start with `DRY_RUN=true` to review the proposed reassignments first.

## Test

```bash
pytest product-missing-default-category-after-deletion/python
node --test product-missing-default-category-after-deletion/node
```
