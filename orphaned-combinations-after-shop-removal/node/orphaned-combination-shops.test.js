import { test } from "node:test";
import assert from "node:assert/strict";
import { findOrphanedCombinationShops } from "./orphaned-combination-shops.js";

const row = (over = {}) => ({ id_product_attribute: 10, id_shop: 1, ...over });

test("no orphans when every row matches product and active shops", () => {
  const productShopIds = new Set([1, 2]);
  const activeShopIds = new Set([1, 2]);
  const rows = [row({ id_shop: 1 }), row({ id_shop: 2, id_product_attribute: 11 })];
  assert.deepEqual(findOrphanedCombinationShops(productShopIds, activeShopIds, rows), []);
});

test("shop unassigned from product is orphaned", () => {
  const productShopIds = new Set([1]);
  const activeShopIds = new Set([1, 2]);
  const rows = [row({ id_shop: 2 })];
  const result = findOrphanedCombinationShops(productShopIds, activeShopIds, rows);
  assert.deepEqual(result, [{ id_product_attribute: 10, id_shop: 2, reason: "shop_unassigned_from_product" }]);
});

test("inactive shop is orphaned even if product still lists it", () => {
  const productShopIds = new Set([1, 3]);
  const activeShopIds = new Set([1]);
  const rows = [row({ id_shop: 3 })];
  const result = findOrphanedCombinationShops(productShopIds, activeShopIds, rows);
  assert.deepEqual(result, [{ id_product_attribute: 10, id_shop: 3, reason: "shop_inactive" }]);
});

test("inactive shop reason wins over unassigned reason", () => {
  const productShopIds = new Set();
  const activeShopIds = new Set();
  const rows = [row({ id_shop: 9 })];
  const result = findOrphanedCombinationShops(productShopIds, activeShopIds, rows);
  assert.deepEqual(result, [{ id_product_attribute: 10, id_shop: 9, reason: "shop_inactive" }]);
});

test("empty rows returns empty list", () => {
  assert.deepEqual(findOrphanedCombinationShops(new Set([1]), new Set([1]), []), []);
});

test("multiple combinations each orphaned independently", () => {
  const productShopIds = new Set([1]);
  const activeShopIds = new Set([1, 2]);
  const rows = [row({ id_product_attribute: 10, id_shop: 2 }), row({ id_product_attribute: 11, id_shop: 2 })];
  const result = findOrphanedCombinationShops(productShopIds, activeShopIds, rows);
  assert.deepEqual(result, [
    { id_product_attribute: 10, id_shop: 2, reason: "shop_unassigned_from_product" },
    { id_product_attribute: 11, id_shop: 2, reason: "shop_unassigned_from_product" },
  ]);
});
