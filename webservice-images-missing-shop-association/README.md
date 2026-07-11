# Product images updated via webservice do not create per shop associations in multistore

Updating a product image through the PrestaShop webservice can return HTTP 200 and really store the file, and still never show up on a second shop in a multistore setup. The webservice image entry point, `WebserviceSpecificManagementImages`, writes the file and updates the `image` row on the PUT path (or a POST carrying `ps_method=PUT`) used to update an existing image, but it never calls the shop association write, `Image::addImageShop`, for the `id_shop` the request carried. This is a confirmed, still-open core bug, [PrestaShop/PrestaShop#35901](https://github.com/PrestaShop/PrestaShop/issues/35901), reported on 8.0.3. This script reads each product's expected shops and images, probes whether each (image, shop) pair actually resolves, and reports every missing triple. It never resubmits the same PUT, since the bug is unconditional and retrying reproduces the same silent no-op.

**Full guide with diagrams:** https://www.allanninal.dev/prestashop/webservice-images-missing-shop-association/

## Run it

```bash
export PRESTASHOP_URL="https://your-shop.example.com"
export PRESTASHOP_WS_KEY="your webservice key"
export PRODUCT_IDS="10,11,12"
export DRY_RUN="true"

python webservice-images-missing-shop-association/python/find_missing_image_shops.py
node   webservice-images-missing-shop-association/node/find-missing-image-shops.js
```

`find_missing_image_shop_associations` is a pure function: given the images a product has, the shops that product is expected to sell in, and the set of (id_image, id_shop) pairs already known to exist, it returns exactly the (id_product, id_image, id_shop) triples that should have an association but don't. The script builds those three inputs by reading `products/{id}?display=full` for `associations.shops`, `images/products/{id}?display=full` for the image list, and probing `images/products/{id}/{id_image}?id_shop={id_shop}` per pair, a 404 meaning the row is missing. The default behavior is to report every missing triple and write nothing, since resubmitting the same webservice PUT reproduces the same silent no-op. The reviewed, `DRY_RUN`-guarded workaround re-uploads the image as a new image scoped to the missing shop with `POST images/products/{id_product}/?id_shop={id_shop}`, since creation is confirmed to honor `id_shop`, and only counts a product as repaired after re-verifying the new image resolves. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest webservice-images-missing-shop-association/python
node --test webservice-images-missing-shop-association/node
```
