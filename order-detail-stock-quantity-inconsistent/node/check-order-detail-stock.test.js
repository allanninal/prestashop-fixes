import { test } from "node:test";
import assert from "node:assert/strict";
import { isStockQuantityInconsistent } from "./check-order-detail-stock.js";

test("ordered one but in stock zero is inconsistent", () => {
  assert.equal(isStockQuantityInconsistent(1, 0), true);
});

test("ordered one and in stock one is consistent", () => {
  assert.equal(isStockQuantityInconsistent(1, 1), false);
});

test("ordered two, one refunded, in stock one is consistent", () => {
  assert.equal(isStockQuantityInconsistent(2, 1, 1), false);
});

test("ordered two, one refunded, in stock zero is inconsistent", () => {
  assert.equal(isStockQuantityInconsistent(2, 0, 1), true);
});

test("zero quantity ordered is never inconsistent", () => {
  assert.equal(isStockQuantityInconsistent(0, 0), false);
});

test("negative quantity ordered is never inconsistent", () => {
  assert.equal(isStockQuantityInconsistent(-1, 0), false);
});

test("fully refunded line matching in stock is consistent", () => {
  assert.equal(isStockQuantityInconsistent(3, 0, 3), false);
});

test("in stock higher than ordered is still inconsistent", () => {
  assert.equal(isStockQuantityInconsistent(1, 2), true);
});
