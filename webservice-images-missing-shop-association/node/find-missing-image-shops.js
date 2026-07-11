/**
 * Detect PrestaShop product images updated via webservice that never got their
 * per shop association written in ps_image_shop, in a multistore setup.
 *
 * The webservice image entry point, WebserviceSpecificManagementImages, writes the
 * uploaded file and updates the image row on the PUT path (or a POST carrying
 * ps_method=PUT) used to update an existing image, but that path never calls the
 * shop association write, Image::addImageShop, for the id_shop the request body
 * carried. This is a confirmed, still-open core bug, PrestaShop/PrestaShop#35901,
 * reported on 8.0.3: the call returns HTTP 200 and the file is stored, but the
 * association always resolves to the default shop instead of the target shop.
 * Plain image creation via POST images/products/{id_product}/ does honor id_shop
 * correctly, so the defect is isolated to the update path.
 *
 * This script reads each product's expected shops and images, probes whether each
 * (image, shop) pair actually resolves, and reports every missing triple. It never
 * resubmits the same PUT, since the bug is unconditional and retrying reproduces
 * the same silent no-op. Under DRY_RUN=true it only reports. The reviewed
 * workaround, only run with DRY_RUN=false, re-uploads the image as a new image
 * scoped to the missing shop, since creation is confirmed to honor id_shop, then
 * re-verifies it resolves before counting the product as repaired.
 *
 * Guide: https://www.allanninal.dev/prestashop/webservice-images-missing-shop-association/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

/**
 * Pure decision function, no I/O.
 *
 * productImages: [{ idProduct, idImage }, ...] from images/products/{id}?display=full
 * productShopAssociations: [{ idProduct, idShop }, ...] from products/{id}?display=full associations.shops
 * imageShopRows: Set of "idImage:idShop" strings known to exist (from ps_image_shop or per-shop probe)
 *
 * Returns [{ idProduct, idImage, idShop }, ...] that SHOULD have an association (because the
 * product is linked to that shop) but don't, the exact set the repair step must act on.
 */
export function findMissingImageShopAssociations(productImages, productShopAssociations, imageShopRows) {
  const expectedShopsByProduct = new Map();
  for (const row of productShopAssociations) {
    if (!expectedShopsByProduct.has(row.idProduct)) expectedShopsByProduct.set(row.idProduct, new Set());
    expectedShopsByProduct.get(row.idProduct).add(row.idShop);
  }

  const missing = [];
  for (const img of productImages) {
    const { idProduct, idImage } = img;
    const shops = expectedShopsByProduct.get(idProduct) || new Set();
    for (const shop of shops) {
      if (!imageShopRows.has(`${idImage}:${shop}`)) {
        missing.push({ idProduct, idImage, idShop: shop });
      }
    }
  }
  return missing;
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function productShopIds(idProduct) {
  const data = await apiGet(`products/${idProduct}`, { display: "full" });
  const shops = (data.product.associations || {}).shops || {};
  return (shops.shop || []).map((s) => Number(s.id));
}

async function productImageIds(idProduct) {
  const data = await apiGet(`images/products/${idProduct}`, { display: "full" });
  let images = data.image || [];
  if (!Array.isArray(images)) images = [images];
  return images.map((img) => Number(img.id));
}

async function imageResolvesInShop(idProduct, idImage, idShop) {
  const url = new URL(`${PRESTASHOP_URL}/api/images/products/${idProduct}/${idImage}`);
  url.searchParams.set("id_shop", idShop);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET images/products/${idProduct}/${idImage}`);
  return true;
}

async function reuploadImageForShop(idProduct, idShop, imageBlob) {
  const url = new URL(`${PRESTASHOP_URL}/api/images/products/${idProduct}/`);
  url.searchParams.set("id_shop", idShop);
  url.searchParams.set("output_format", "JSON");
  const form = new FormData();
  form.append("image", imageBlob, "image.jpg");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: basicAuthHeader() },
    body: form,
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on POST images/products/${idProduct}/`);
  return res.json();
}

async function collectMissingTriples(productIds) {
  const productImages = [];
  const productShopAssociations = [];
  const imageShopRows = new Set();

  for (const idProduct of productIds) {
    const shopIds = await productShopIds(idProduct);
    for (const idShop of shopIds) productShopAssociations.push({ idProduct, idShop });

    const imageIds = await productImageIds(idProduct);
    for (const idImage of imageIds) {
      productImages.push({ idProduct, idImage });
      for (const idShop of shopIds) {
        if (await imageResolvesInShop(idProduct, idImage, idShop)) {
          imageShopRows.add(`${idImage}:${idShop}`);
        }
      }
    }
  }

  return findMissingImageShopAssociations(productImages, productShopAssociations, imageShopRows);
}

export async function run(productIds) {
  const missing = await collectMissingTriples(productIds);
  for (const { idProduct, idImage, idShop } of missing) {
    console.warn(
      `Product ${idProduct} image ${idImage} missing association for shop ${idShop}. ` +
      (DRY_RUN ? "would re-upload as a new shop image" : "re-uploading as a new shop image")
    );
    if (!DRY_RUN) {
      console.error(
        `Re-upload requires the source image bytes, supply them via your own image loader ` +
        `and call reuploadImageForShop(${idProduct}, ${idShop}, imageBlob) before re-verifying.`
      );
    }
  }
  console.log(`Done. ${missing.length} missing association(s) found.`);
  return missing;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targetProductIds = (process.env.PRODUCT_IDS || "")
    .split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  run(targetProductIds).catch((err) => { console.error(err); process.exit(1); });
}
