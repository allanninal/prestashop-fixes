import { test } from "node:test";
import assert from "node:assert/strict";
import { findShopMismatchedCombinations } from "./find-shop-mismatch.js";

const combo = (over = {}) => ({ id_product_attribute: 100, id_product: 10, price: 19.99, minimal_quantity: 1, ...over });

test("flags when resolved shop not in actual shops", () => {
  const result = findShopMismatchedCombinations(1, [combo()], new Map([[100, new Set([2, 3])]]));
  assert.equal(result.length, 1);
  assert.equal(result[0].id_product_attribute, 100);
  assert.equal(result[0].resolved_in_shop, 1);
  assert.deepEqual(result[0].actual_shops, [2, 3]);
});

test("no flag when resolved shop is among actual shops", () => {
  const result = findShopMismatchedCombinations(1, [combo()], new Map([[100, new Set([1, 2])]]));
  assert.deepEqual(result, []);
});

test("no flag when only one shop and it matches", () => {
  const result = findShopMismatchedCombinations(1, [combo()], new Map([[100, new Set([1])]]));
  assert.deepEqual(result, []);
});

test("flags when combination has no association at all", () => {
  const result = findShopMismatchedCombinations(1, [combo()], new Map());
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].actual_shops, []);
});

test("multiple combinations, only mismatched ones flagged", () => {
  const combos = [combo({ id_product_attribute: 100 }), combo({ id_product_attribute: 200 })];
  const shopMap = new Map([[100, new Set([1])], [200, new Set([2])]]);
  const result = findShopMismatchedCombinations(1, combos, shopMap);
  assert.equal(result.length, 1);
  assert.equal(result[0].id_product_attribute, 200);
});

test("reason explains missing association", () => {
  const result = findShopMismatchedCombinations(1, [combo()], new Map([[100, new Set([2])]]));
  assert.match(result[0].reason, /product_attribute_shop/);
});

test("multiple shops for one combination sorted", () => {
  const result = findShopMismatchedCombinations(5, [combo()], new Map([[100, new Set([3, 1, 2])]]));
  assert.deepEqual(result[0].actual_shops, [1, 2, 3]);
});

test("no combinations returns empty array", () => {
  const result = findShopMismatchedCombinations(1, [], new Map([[100, new Set([1])]]));
  assert.deepEqual(result, []);
});
