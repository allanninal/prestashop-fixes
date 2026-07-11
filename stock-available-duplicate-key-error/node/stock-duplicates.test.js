import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicateStockRows, findOrphanedCombinationRows } from "./find-duplicate-stock.js";

const row = (over = {}) => ({
  id: 1, id_product: 10, id_product_attribute: 0, id_shop: 1, id_shop_group: 1, quantity: 5,
  ...over,
});

test("no duplicates when all keys are unique", () => {
  const rows = [row({ id: 1 }), row({ id: 2, id_product_attribute: 2 })];
  assert.deepEqual(findDuplicateStockRows(rows), []);
});

test("finds a duplicate group for the same natural key", () => {
  const rows = [row({ id: 1, quantity: 5 }), row({ id: 2, quantity: 8 })];
  const groups = findDuplicateStockRows(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
});

test("keep candidate is the highest id when shop is tied", () => {
  const rows = [row({ id: 1, id_shop: 0, id_shop_group: 0 }), row({ id: 2, id_shop: 0, id_shop_group: 0 })];
  const groups = findDuplicateStockRows(rows);
  assert.equal(groups[0][0].id, 2);
});

test("rows with different shop scope are not grouped together", () => {
  const rows = [row({ id: 9, id_shop: 0, id_shop_group: 0 }), row({ id: 2, id_shop: 1, id_shop_group: 1 })];
  assert.deepEqual(findDuplicateStockRows(rows), []);
});

test("three way duplicate group keeps the highest id", () => {
  const rows = [row({ id: 1 }), row({ id: 2 }), row({ id: 3 })];
  const groups = findDuplicateStockRows(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 3);
  assert.equal(groups[0][0].id, 3);
});

test("orphaned rows are flagged when the combination is missing", () => {
  const rows = [row({ id: 1, id_product_attribute: 99 })];
  assert.deepEqual(findOrphanedCombinationRows(rows, new Set([1, 2])), rows);
});

test("no orphan for a simple product row with attribute 0", () => {
  const rows = [row({ id: 1, id_product_attribute: 0 })];
  assert.deepEqual(findOrphanedCombinationRows(rows, new Set([1, 2])), []);
});

test("no orphan when the combination is still live", () => {
  const rows = [row({ id: 1, id_product_attribute: 2 })];
  assert.deepEqual(findOrphanedCombinationRows(rows, new Set([1, 2])), []);
});
