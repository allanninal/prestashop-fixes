import { test } from "node:test";
import assert from "node:assert/strict";
import { findOrphanStockRows } from "./orphaned-stock-rows.js";

const combo = (id) => ({ id });

const row = (over = {}) => ({ id: 1, id_product_attribute: 5, quantity: 0, out_of_stock: 2, ...over });

test("no orphans when every row matches a live combination", () => {
  const combinations = [combo(5), combo(6)];
  const stockRows = [row({ id_product_attribute: 5 }), row({ id: 2, id_product_attribute: 6 })];
  assert.deepEqual(findOrphanStockRows(combinations, stockRows), []);
});

test("base product row with zero attribute is never an orphan", () => {
  const stockRows = [row({ id: 1, id_product_attribute: 0 })];
  assert.deepEqual(findOrphanStockRows([], stockRows), []);
});

test("empty combinations list only keeps the zero row", () => {
  const stockRows = [row({ id: 1, id_product_attribute: 0 }), row({ id: 2, id_product_attribute: 7, quantity: 4 })];
  const result = findOrphanStockRows([], stockRows);
  assert.deepEqual(result, [row({ id: 2, id_product_attribute: 7, quantity: 4 })]);
});

test("stock row for deleted combination is an orphan", () => {
  const combinations = [combo(5)];
  const stockRows = [row({ id: 1, id_product_attribute: 5 }), row({ id: 2, id_product_attribute: 9, quantity: 3 })];
  const result = findOrphanStockRows(combinations, stockRows);
  assert.deepEqual(result, [row({ id: 2, id_product_attribute: 9, quantity: 3 })]);
});

test("duplicate stock rows for the same orphaned attribute are all returned", () => {
  const stockRows = [
    row({ id: 2, id_product_attribute: 9, quantity: 3 }),
    row({ id: 3, id_product_attribute: 9, quantity: 2 }),
  ];
  const result = findOrphanStockRows([], stockRows);
  assert.deepEqual(result, stockRows);
});

test("combination present but stock row missing is not flagged as orphan", () => {
  const combinations = [combo(5), combo(6)];
  const stockRows = [row({ id: 1, id_product_attribute: 5 })];
  assert.deepEqual(findOrphanStockRows(combinations, stockRows), []);
});

test("orphan quantity sum reflects inflated displayed total", () => {
  const combinations = [combo(5)];
  const stockRows = [
    row({ id: 1, id_product_attribute: 5, quantity: 10 }),
    row({ id: 2, id_product_attribute: 9, quantity: 3 }),
    row({ id: 3, id_product_attribute: 12, quantity: 7 }),
  ];
  const orphans = findOrphanStockRows(combinations, stockRows);
  const total = orphans.reduce((sum, o) => sum + o.quantity, 0);
  assert.equal(total, 10);
});
