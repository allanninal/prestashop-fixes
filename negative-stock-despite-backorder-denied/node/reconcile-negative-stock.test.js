import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStockViolation } from "./reconcile-negative-stock.js";

test("deny and negative is a violation", () => {
  const result = classifyStockViolation(-3, 0, true);
  assert.deepEqual(result, { policy: "deny", isViolation: true, clampTo: 0 });
});

test("allow and negative is not a violation", () => {
  const result = classifyStockViolation(-3, 1, true);
  assert.equal(result.isViolation, false);
  assert.equal(result.clampTo, null);
});

test("deny and positive is not a violation", () => {
  const result = classifyStockViolation(5, 0, true);
  assert.equal(result.isViolation, false);
});

test("default inherits deny from global", () => {
  const result = classifyStockViolation(-2, 2, true);
  assert.equal(result.policy, "deny");
  assert.equal(result.isViolation, true);
  assert.equal(result.clampTo, 0);
});

test("default inherits allow from global", () => {
  const result = classifyStockViolation(-2, 2, false);
  assert.equal(result.policy, "allow");
  assert.equal(result.isViolation, false);
  assert.equal(result.clampTo, null);
});

test("clampTo uses max of quantity and zero", () => {
  const result = classifyStockViolation(-7, 0, true);
  assert.equal(result.clampTo, 0);
});

test("zero quantity with deny is not a violation", () => {
  const result = classifyStockViolation(0, 0, true);
  assert.equal(result.isViolation, false);
  assert.equal(result.clampTo, null);
});

test("allow policy ignores global default", () => {
  const result = classifyStockViolation(-10, 1, false);
  assert.equal(result.policy, "allow");
  assert.equal(result.isViolation, false);
});
