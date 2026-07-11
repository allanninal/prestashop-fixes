import { test } from "node:test";
import assert from "node:assert/strict";
import { checkStockInvariant } from "./check-stock-invariant.js";

const stockRow = (over = {}) => ({ quantity: 7, physicalQuantity: 10, reservedQuantity: 3, ...over });

test("in sync when formula and reserved match", () => {
  const result = checkStockInvariant(stockRow(), 3);
  assert.equal(result.inSync, true);
  assert.equal(result.formulaViolation, false);
  assert.equal(result.reservedMismatch, false);
  assert.equal(result.expectedQuantity, 7);
});

test("formula violation when physical does not equal quantity plus reserved", () => {
  const row = stockRow({ quantity: 7, physicalQuantity: 10, reservedQuantity: 1 });
  const result = checkStockInvariant(row, 1);
  assert.equal(result.formulaViolation, true);
  assert.equal(result.reservedMismatch, false);
  assert.equal(result.inSync, false);
  assert.equal(result.expectedQuantity, 9);
});

test("reserved mismatch when computed differs from stored", () => {
  const row = stockRow({ quantity: 7, physicalQuantity: 10, reservedQuantity: 3 });
  const result = checkStockInvariant(row, 5);
  assert.equal(result.reservedMismatch, true);
  assert.equal(result.formulaViolation, false);
  assert.equal(result.inSync, false);
  assert.equal(result.expectedQuantity, 5);
});

test("both violations can be true at once", () => {
  const row = stockRow({ quantity: 7, physicalQuantity: 10, reservedQuantity: 1 });
  const result = checkStockInvariant(row, 5);
  assert.equal(result.formulaViolation, true);
  assert.equal(result.reservedMismatch, true);
  assert.equal(result.inSync, false);
  assert.equal(result.expectedQuantity, 5);
});

test("out of stock forced negative quantity is flagged", () => {
  // Documented core bug: quantity forced to -1 while reserved_quantity goes to 1.
  const row = stockRow({ quantity: -1, physicalQuantity: 0, reservedQuantity: 1 });
  const result = checkStockInvariant(row, 0);
  assert.equal(result.formulaViolation, false);
  assert.equal(result.reservedMismatch, true);
  assert.equal(result.inSync, false);
  assert.equal(result.expectedQuantity, 0);
});

test("zero reserved after multistore share stock reset", () => {
  const row = stockRow({ quantity: 10, physicalQuantity: 10, reservedQuantity: 0 });
  const result = checkStockInvariant(row, 4);
  assert.equal(result.reservedMismatch, true);
  assert.equal(result.expectedQuantity, 6);
  assert.equal(result.inSync, false);
});
