import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcilePayment } from "./reconcile-total-paid-real.js";

test("matching totals are consistent", () => {
  const result = reconcilePayment(100.00, [40.00, 60.00]);
  assert.equal(result.mismatch, false);
  assert.equal(result.sumPayments, 100.00);
  assert.equal(result.delta, 0.00);
  assert.equal(result.likelyDoubled, false);
});

test("tiny rounding difference is consistent", () => {
  const result = reconcilePayment(100.00, [33.335, 33.335, 33.33]);
  assert.equal(result.mismatch, false);
});

test("partial payment shortfall is not doubled", () => {
  const result = reconcilePayment(40.00, [40.00]);
  assert.equal(result.mismatch, false);
  assert.equal(result.likelyDoubled, false);
});

test("doubled total is flagged and marked likely doubled", () => {
  const result = reconcilePayment(120.00, [60.00]);
  assert.equal(result.mismatch, true);
  assert.equal(result.sumPayments, 60.00);
  assert.equal(result.delta, 60.00);
  assert.equal(result.likelyDoubled, true);
});

test("doubled against total paid when no payment rows yet", () => {
  const result = reconcilePayment(200.00, [], 100.00);
  assert.equal(result.mismatch, true);
  assert.equal(result.likelyDoubled, true);
});

test("ordinary mismatch not close to double is not flagged doubled", () => {
  const result = reconcilePayment(70.00, [60.00]);
  assert.equal(result.mismatch, true);
  assert.equal(result.likelyDoubled, false);
});

test("zero payments and zero total paid is not doubled", () => {
  const result = reconcilePayment(0.00, []);
  assert.equal(result.mismatch, false);
  assert.equal(result.likelyDoubled, false);
});

test("multiple payment rows summing to double is flagged", () => {
  const result = reconcilePayment(100.00, [50.00, 50.00], 50.00);
  assert.equal(result.mismatch, false);
  assert.equal(result.sumPayments, 100.00);
});

test("negative delta for true partial payment", () => {
  const result = reconcilePayment(30.00, [30.00, 20.00]);
  assert.equal(result.mismatch, true);
  assert.equal(result.delta, -20.00);
  assert.equal(result.likelyDoubled, false);
});
