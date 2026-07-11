import { test } from "node:test";
import assert from "node:assert/strict";
import { diffOrderTotal } from "./check-order-total.js";

test("matching totals are consistent", () => {
  const result = diffOrderTotal(110.00, [50.00, 50.00], 10.00, 0.00);
  assert.equal(result.computed_total, 110.00);
  assert.equal(result.diff, 0.00);
  assert.equal(result.mismatched, false);
});

test("tiny rounding difference is consistent", () => {
  const result = diffOrderTotal(110.01, [50.00, 50.00], 10.00, 0.00);
  assert.equal(result.mismatched, false);
});

test("missing line is flagged", () => {
  const result = diffOrderTotal(110.00, [50.00], 10.00, 0.00);
  assert.equal(result.computed_total, 60.00);
  assert.equal(result.diff, 50.00);
  assert.equal(result.mismatched, true);
});

test("discount reduces computed total", () => {
  const result = diffOrderTotal(90.00, [50.00, 50.00], 10.00, 20.00);
  assert.equal(result.computed_total, 90.00);
  assert.equal(result.mismatched, false);
});

test("stale total after edit is flagged", () => {
  const result = diffOrderTotal(150.00, [50.00, 50.00], 10.00, 0.00);
  assert.equal(result.computed_total, 110.00);
  assert.equal(result.diff, 40.00);
  assert.equal(result.mismatched, true);
});

test("custom epsilon is respected", () => {
  const result = diffOrderTotal(110.03, [50.00, 50.00], 10.00, 0.00, 0.05);
  assert.equal(result.mismatched, false);
});

test("no lines uses shipping and discounts only", () => {
  const result = diffOrderTotal(10.00, [], 10.00, 0.00);
  assert.equal(result.computed_total, 10.00);
  assert.equal(result.mismatched, false);
});

test("overpaid total is flagged with positive diff", () => {
  const result = diffOrderTotal(200.00, [50.00, 50.00], 10.00, 0.00);
  assert.equal(result.diff, 90.00);
  assert.equal(result.mismatched, true);
});
