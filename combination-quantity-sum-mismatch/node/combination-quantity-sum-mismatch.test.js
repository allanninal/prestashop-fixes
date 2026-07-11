import { test } from "node:test";
import assert from "node:assert/strict";
import { findStockMismatches } from "./combination-quantity-sum-mismatch.js";

const SHOP_ID = 1;

const combo = (id) => ({ id, id_product: 10 });

const row = (over = {}) => ({
  id: 900,
  id_product: 10,
  id_product_attribute: 0,
  id_shop: SHOP_ID,
  quantity: 0,
  ...over,
});

test("no mismatch when sum matches product row", () => {
  const combinations = [combo(1), combo(2)];
  const rows = [
    row({ id: 900, id_product_attribute: 0, quantity: 7 }),
    row({ id: 901, id_product_attribute: 1, quantity: 3 }),
    row({ id: 902, id_product_attribute: 2, quantity: 4 }),
  ];
  const result = findStockMismatches(10, combinations, rows, SHOP_ID);
  assert.equal(result.isMismatched, false);
  assert.equal(result.combinationQuantitySum, 7);
  assert.equal(result.delta, 0);
  assert.deepEqual(result.orphanedRowIds, []);
});

test("positive delta when product row higher than sum", () => {
  const combinations = [combo(1)];
  const rows = [
    row({ id: 900, id_product_attribute: 0, quantity: 10 }),
    row({ id: 901, id_product_attribute: 1, quantity: 4 }),
  ];
  const result = findStockMismatches(10, combinations, rows, SHOP_ID);
  assert.equal(result.isMismatched, true);
  assert.equal(result.delta, 6);
});

test("negative delta when product row lower than sum", () => {
  const combinations = [combo(1)];
  const rows = [
    row({ id: 900, id_product_attribute: 0, quantity: 2 }),
    row({ id: 901, id_product_attribute: 1, quantity: 9 }),
  ];
  const result = findStockMismatches(10, combinations, rows, SHOP_ID);
  assert.equal(result.isMismatched, true);
  assert.equal(result.delta, -7);
});

test("orphaned row reported even when sum matches", () => {
  const combinations = [combo(1)];
  const rows = [
    row({ id: 900, id_product_attribute: 0, quantity: 4 }),
    row({ id: 901, id_product_attribute: 1, quantity: 4 }),
    row({ id: 902, id_product_attribute: 5, quantity: 99 }),
  ];
  const result = findStockMismatches(10, combinations, rows, SHOP_ID);
  assert.deepEqual(result.orphanedRowIds, [902]);
  assert.equal(result.combinationQuantitySum, 4);
  assert.equal(result.isMismatched, false);
});

test("zero combinations is never flagged", () => {
  const rows = [row({ id: 900, id_product_attribute: 0, quantity: 123 })];
  const result = findStockMismatches(10, [], rows, SHOP_ID);
  assert.equal(result.isMismatched, false);
  assert.equal(result.productLevelQuantity, 123);
});

test("rows scoped to requested shop only", () => {
  const combinations = [combo(1)];
  const rows = [
    row({ id: 900, id_product_attribute: 0, id_shop: 2, quantity: 999 }),
    row({ id: 901, id_product_attribute: 1, id_shop: 1, quantity: 5 }),
  ];
  const result = findStockMismatches(10, combinations, rows, SHOP_ID);
  assert.equal(result.productLevelQuantity, null);
  assert.equal(result.combinationQuantitySum, 5);
});

test("missing product row defaults to null quantity", () => {
  const combinations = [combo(1)];
  const rows = [row({ id: 901, id_product_attribute: 1, quantity: 5 })];
  const result = findStockMismatches(10, combinations, rows, SHOP_ID);
  assert.equal(result.productLevelQuantity, null);
  assert.equal(result.delta, -5);
  assert.equal(result.isMismatched, true);
});
