/**
 * Detect and safely repair PrestaShop products whose ps_image cover flag is
 * missing or duplicated, which breaks the storefront main image link.
 *
 * ps_image enforces a unique key on (id_product, cover), so the database only
 * ever allows one row per product where cover = 1. But the webservice image
 * upload path, POST /api/images/products/{id}, never checks for an existing
 * cover before inserting a new image, so a second cover upload on a product
 * that already has one throws a duplicate key SQL error, tracked in
 * PrestaShop/PrestaShop#22803 and #23777. Separately, CSV import, product
 * duplication, and an interrupted API write can leave a product with zero
 * cover rows, since the cover flag is not copied or assigned automatically,
 * which breaks Image::getCover($id_product) on the storefront.
 *
 * This script reads each product's images, classifies the cover state with a
 * pure function, and reports every product with zero or more than one cover.
 * Under DRY_RUN=true it only reports. The guarded repair path, only run with
 * DRY_RUN=false, demotes every extra cover but one or promotes a chosen image,
 * one PUT at a time, re-reading after each write to confirm the result before
 * moving to the next product.
 *
 * Guide: https://www.allanninal.dev/prestashop/cover-image-missing-or-duplicated/
 */
import { pathToFileURL } from "node:url";

const PRESTASHOP_URL = (process.env.PRESTASHOP_URL || "https://demo.example.com").replace(/\/+$/, "");
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY || "WSKEYDUMMY";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${PRESTASHOP_WS_KEY}:`).toString("base64");
}

function truthyCover(value) {
  return value === true || value === "1" || value === 1;
}

/**
 * Pure decision function, no I/O.
 *
 * images: [{ id_image, cover: "0"|"1"|boolean, position }, ...]
 *
 * Returns { status: "ok"|"no_cover"|"multi_cover"|"no_images", coverIds: [...], chosenCoverId }
 *
 * 1. Empty images -> no_images, nothing to fix.
 * 2. Exactly one truthy cover -> ok.
 * 3. Zero truthy covers -> no_cover, chosen is the lowest position (ties by lowest id_image).
 * 4. More than one truthy cover -> multi_cover, chosen is the lowest position among the
 *    cover-flagged images (ties by lowest id_image); the rest of coverIds should be demoted.
 */
export function classifyCoverState(images) {
  if (!images || images.length === 0) {
    return { status: "no_images", coverIds: [], chosenCoverId: null };
  }

  const coverIds = images.filter((img) => truthyCover(img.cover)).map((img) => img.id_image);

  if (coverIds.length === 1) {
    return { status: "ok", coverIds, chosenCoverId: coverIds[0] };
  }

  const byPositionThenId = (a, b) =>
    (a.position ?? 0) - (b.position ?? 0) || (a.id_image > b.id_image ? 1 : a.id_image < b.id_image ? -1 : 0);

  if (coverIds.length === 0) {
    const chosen = [...images].sort(byPositionThenId)[0].id_image;
    return { status: "no_cover", coverIds: [], chosenCoverId: chosen };
  }

  const coverImages = images.filter((img) => coverIds.includes(img.id_image));
  const chosen = [...coverImages].sort(byPositionThenId)[0].id_image;
  return { status: "multi_cover", coverIds, chosenCoverId: chosen };
}

async function apiGet(path, params = {}) {
  const url = new URL(`${PRESTASHOP_URL}/api/${path}`);
  url.searchParams.set("output_format", "JSON");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: basicAuthHeader() } });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on GET ${path}`);
  return res.json();
}

async function apiPutCover(idProduct, idImage, coverValue) {
  const url = new URL(`${PRESTASHOP_URL}/api/images/products/${idProduct}/${idImage}`);
  url.searchParams.set("output_format", "JSON");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ image: { id: idImage, cover: coverValue } }),
  });
  if (!res.ok) throw new Error(`PrestaShop ${res.status} on PUT images/products/${idProduct}/${idImage}`);
  return res.json();
}

async function activeProductIds(limit = "0,100") {
  const data = await apiGet("products", { display: "full", "filter[active]": "1", limit });
  let products = data.products || [];
  if (!Array.isArray(products)) products = [products];
  return products.map((p) => Number(p.id));
}

async function productImageIds(idProduct) {
  const data = await apiGet(`images/products/${idProduct}`);
  let images = data.image || [];
  if (!Array.isArray(images)) images = [images];
  return images.map((img) => Number(img.id));
}

async function fetchImageRecord(idProduct, idImage) {
  const data = await apiGet(`images/products/${idProduct}/${idImage}`);
  const img = data.image || {};
  return {
    id_image: Number(img.id ?? idImage),
    cover: img.cover,
    position: Number(img.position ?? 0),
  };
}

async function fetchProductImages(idProduct) {
  const ids = await productImageIds(idProduct);
  const records = [];
  for (const idImage of ids) records.push(await fetchImageRecord(idProduct, idImage));
  return records;
}

function reportProduct(idProduct, classification) {
  if (classification.status === "ok" || classification.status === "no_images") return;
  console.warn(
    `Product ${idProduct} status=${classification.status} coverIds=${JSON.stringify(classification.coverIds)} suggestedCoverId=${classification.chosenCoverId}`
  );
}

async function repairProduct(idProduct, classification) {
  const { status, chosenCoverId } = classification;

  if (status === "multi_cover") {
    for (const idImage of classification.coverIds) {
      if (idImage === chosenCoverId) continue;
      await apiPutCover(idProduct, idImage, "0");
      const confirmed = await fetchImageRecord(idProduct, idImage);
      if (truthyCover(confirmed.cover)) {
        throw new Error(`Product ${idProduct} image ${idImage} still cover after demote, stopping`);
      }
    }
    await apiPutCover(idProduct, chosenCoverId, "1");
    const confirmed = await fetchImageRecord(idProduct, chosenCoverId);
    if (!truthyCover(confirmed.cover)) {
      throw new Error(`Product ${idProduct} chosen cover ${chosenCoverId} did not confirm, stopping`);
    }
  } else if (status === "no_cover") {
    await apiPutCover(idProduct, chosenCoverId, "1");
    const confirmed = await fetchImageRecord(idProduct, chosenCoverId);
    if (!truthyCover(confirmed.cover)) {
      throw new Error(`Product ${idProduct} chosen cover ${chosenCoverId} did not confirm, stopping`);
    }
  }
}

export async function run(productIds) {
  let broken = 0;
  for (const idProduct of productIds) {
    const images = await fetchProductImages(idProduct);
    const classification = classifyCoverState(images);
    if (classification.status === "ok" || classification.status === "no_images") continue;
    broken++;
    reportProduct(idProduct, classification);
    if (!DRY_RUN) {
      console.log(`Repairing product ${idProduct} (${classification.status})`);
      await repairProduct(idProduct, classification);
    }
  }
  console.log(`Done. ${broken} product(s) with a broken cover ${DRY_RUN ? "found" : "repaired"}.`);
  return broken;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targetProductIds = (process.env.PRODUCT_IDS || "")
    .split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  run(targetProductIds).catch((err) => { console.error(err); process.exit(1); });
}
