import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedStockDelta } from "./reconcile-stock.js";

const NOT_LOGABLE = { id: 1, logable: false, shipped: false };
const LOGABLE = { id: 2, logable: true, shipped: false };

test("becoming logable decrements stock", () => {
  assert.equal(expectedStockDelta(NOT_LOGABLE, LOGABLE, 3, [], 2), -3);
});

test("leaving logable restocks", () => {
  assert.equal(expectedStockDelta(LOGABLE, NOT_LOGABLE, 3, [2], 1), 3);
});

test("non logable to non logable is a no-op", () => {
  const otherNotLogable = { id: 3, logable: false, shipped: false };
  assert.equal(expectedStockDelta(NOT_LOGABLE, otherNotLogable, 3, [], 3), 0);
});

test("duplicate transition to same state is a no-op", () => {
  assert.equal(expectedStockDelta(NOT_LOGABLE, LOGABLE, 3, [2], 2), 0);
});

test("logable to logable is a no-op", () => {
  const otherLogable = { id: 4, logable: true, shipped: true };
  assert.equal(expectedStockDelta(LOGABLE, otherLogable, 3, [2], 4), 0);
});

test("duplicate check uses candidate state not from state", () => {
  assert.equal(expectedStockDelta(LOGABLE, NOT_LOGABLE, 5, [1], 1), 0);
});

test("line quantity of zero yields zero delta either direction", () => {
  assert.equal(expectedStockDelta(NOT_LOGABLE, LOGABLE, 0, [], 2), 0);
  assert.equal(expectedStockDelta(LOGABLE, NOT_LOGABLE, 0, [2], 1), 0);
});
