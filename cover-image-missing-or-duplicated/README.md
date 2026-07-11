# Cover image missing or duplicated, breaking storefront image links

PrestaShop's `ps_image` table enforces a unique key on `(id_product, cover)`, so the database only ever allows one row per product where `cover = 1`. But the webservice image upload path, `POST /api/images/products/{id}`, never checks for an existing cover before inserting a new image, so pushing a second cover image at a product that already has one throws a duplicate key SQL error, tracked in [PrestaShop/PrestaShop#22803](https://github.com/PrestaShop/PrestaShop/issues/22803) and [#23777](https://github.com/PrestaShop/PrestaShop/issues/23777). Separately, CSV import, product duplication, and an interrupted API write can leave a product with zero cover rows, which breaks the storefront main image lookup, `Image::getCover($id_product)`. This script reads each product's images, classifies the cover state with a pure function, and reports every product with zero or more than one cover.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/cover-image-missing-or-duplicated/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export PRODUCT_IDS="10,11,12"
export DRY_RUN="true"

python cover-image-missing-or-duplicated/python/fix_cover_image.py
node   cover-image-missing-or-duplicated/node/fix-cover-image.js
```

`classify_cover_state` is a pure function: given a product's images with their `cover` flag and `position`, it returns `ok` when exactly one image is the cover, `no_images` when the product has no photos, `no_cover` when none are flagged, or `multi_cover` when more than one is, along with the single `chosenCoverId` (lowest position, ties broken by lowest `id_image`) that should end up as the sole cover. The default behavior is to report every broken product and write nothing. The guarded repair, only enabled with `DRY_RUN=false`, demotes every extra cover but one or promotes the chosen image, issuing one `PUT images/products/{id_product}/{id_image}` at a time and re-reading the image after each write to confirm the result before moving to the next product, since a partial failure from the same unique key constraint must not be retried blindly. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest cover-image-missing-or-duplicated/python
node --test cover-image-missing-or-duplicated/node
```
