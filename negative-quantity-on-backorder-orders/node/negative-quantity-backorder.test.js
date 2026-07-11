import { test } from "node:test";
import assert from "node:assert/strict";
import { clampNegativeStock } from "./negative-quantity-backorder.js";

test("noop when quantity is not negative", () => {
  assert.deepEqual(clampNegativeStock(5, true, 0, false), [5, "noop"]);
});

test("noop when quantity is exactly zero", () => {
  assert.deepEqual(clampNegativeStock(0, true, 1, false), [0, "noop"]);
});

test("flag when not tracked by depends_on_stock", () => {
  assert.deepEqual(clampNegativeStock(-2, false, 0, false), [-2, "flag_manual_review"]);
});

test("flag when backorders allowed and real demand open", () => {
  assert.deepEqual(clampNegativeStock(-4, true, 1, true), [-4, "flag_manual_review"]);
});

test("clamp when backorders denied", () => {
  assert.deepEqual(clampNegativeStock(-3, true, 0, false), [0, "clamp_to_zero"]);
});

test("clamp when backorders allowed but no open backorder paid order", () => {
  assert.deepEqual(clampNegativeStock(-1, true, 1, false), [0, "clamp_to_zero"]);
});

test("clamp when global default policy and no open demand", () => {
  assert.deepEqual(clampNegativeStock(-7, true, 2, false), [0, "clamp_to_zero"]);
});

test("clamp when global default policy and open demand still clamps", () => {
  // outOfStockPolicy === 2 (global default) is not explicit backorder allow (1),
  // so even with an open backorder-paid order this is treated as drift, not demand.
  assert.deepEqual(clampNegativeStock(-5, true, 2, true), [0, "clamp_to_zero"]);
});

test("not tracked takes priority over backorder demand", () => {
  // dependsOnStock false always short-circuits to flag_manual_review, regardless
  // of policy or open demand, since the value is meaningless for decrement purposes.
  assert.deepEqual(clampNegativeStock(-9, false, 1, true), [-9, "flag_manual_review"]);
});
