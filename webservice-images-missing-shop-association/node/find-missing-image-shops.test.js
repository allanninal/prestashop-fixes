import { test } from "node:test";
import assert from "node:assert/strict";
import { findMissingImageShopAssociations } from "./find-missing-image-shops.js";

test("no missing when every shop has a row", () => {
  const productImages = [{ idProduct: 10, idImage: 100 }];
  const productShopAssociations = [{ idProduct: 10, idShop: 1 }, { idProduct: 10, idShop: 2 }];
  const imageShopRows = new Set(["100:1", "100:2"]);
  const result = findMissingImageShopAssociations(productImages, productShopAssociations, imageShopRows);
  assert.deepEqual(result, []);
});

test("flags missing second shop", () => {
  const productImages = [{ idProduct: 10, idImage: 100 }];
  const productShopAssociations = [{ idProduct: 10, idShop: 1 }, { idProduct: 10, idShop: 2 }];
  const imageShopRows = new Set(["100:1"]);
  const result = findMissingImageShopAssociations(productImages, productShopAssociations, imageShopRows);
  assert.deepEqual(result, [{ idProduct: 10, idImage: 100, idShop: 2 }]);
});

test("multiple images and shops", () => {
  const productImages = [{ idProduct: 10, idImage: 100 }, { idProduct: 10, idImage: 101 }];
  const productShopAssociations = [{ idProduct: 10, idShop: 1 }, { idProduct: 10, idShop: 2 }];
  const imageShopRows = new Set(["100:1", "100:2", "101:1"]);
  const result = findMissingImageShopAssociations(productImages, productShopAssociations, imageShopRows);
  assert.deepEqual(result, [{ idProduct: 10, idImage: 101, idShop: 2 }]);
});

test("no expected shops means nothing missing", () => {
  const productImages = [{ idProduct: 10, idImage: 100 }];
  const result = findMissingImageShopAssociations(productImages, [], new Set());
  assert.deepEqual(result, []);
});

test("image with no rows at all flags every expected shop", () => {
  const productImages = [{ idProduct: 10, idImage: 100 }];
  const productShopAssociations = [{ idProduct: 10, idShop: 1 }, { idProduct: 10, idShop: 3 }];
  const result = findMissingImageShopAssociations(productImages, productShopAssociations, new Set());
  const sorted = [...result].sort((a, b) => a.idShop - b.idShop);
  assert.deepEqual(sorted, [
    { idProduct: 10, idImage: 100, idShop: 1 },
    { idProduct: 10, idImage: 100, idShop: 3 },
  ]);
});

test("ignores shops not expected by the product", () => {
  const productImages = [{ idProduct: 10, idImage: 100 }];
  const productShopAssociations = [{ idProduct: 10, idShop: 1 }];
  const imageShopRows = new Set(["100:9"]);
  const result = findMissingImageShopAssociations(productImages, productShopAssociations, imageShopRows);
  assert.deepEqual(result, [{ idProduct: 10, idImage: 100, idShop: 1 }]);
});

test("different products are kept separate", () => {
  const productImages = [{ idProduct: 10, idImage: 100 }, { idProduct: 20, idImage: 200 }];
  const productShopAssociations = [{ idProduct: 10, idShop: 1 }, { idProduct: 20, idShop: 1 }];
  const imageShopRows = new Set(["100:1"]);
  const result = findMissingImageShopAssociations(productImages, productShopAssociations, imageShopRows);
  assert.deepEqual(result, [{ idProduct: 20, idImage: 200, idShop: 1 }]);
});
