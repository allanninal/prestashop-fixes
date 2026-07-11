import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRefundDelta } from "./fix-api-refund-quantity.js";

test("matching quantities need nothing", () => {
  const result = computeRefundDelta(2, [2]);
  assert.equal(result.expected, 2);
  assert.equal(result.delta, 0);
  assert.equal(result.needs_repair, false);
  assert.equal(result.needs_review, false);
});

test("stale stored quantity needs repair", () => {
  const result = computeRefundDelta(0, [3]);
  assert.equal(result.expected, 3);
  assert.equal(result.delta, 3);
  assert.equal(result.needs_repair, true);
  assert.equal(result.needs_review, false);
});

test("multiple credit slips sum together", () => {
  const result = computeRefundDelta(1, [1, 2]);
  assert.equal(result.expected, 3);
  assert.equal(result.delta, 2);
  assert.equal(result.needs_repair, true);
});

test("stored higher than slips needs review", () => {
  const result = computeRefundDelta(5, [2]);
  assert.equal(result.expected, 2);
  assert.equal(result.delta, -3);
  assert.equal(result.needs_repair, false);
  assert.equal(result.needs_review, true);
});

test("no credit slips means zero expected", () => {
  const result = computeRefundDelta(0, []);
  assert.equal(result.expected, 0);
  assert.equal(result.delta, 0);
  assert.equal(result.needs_repair, false);
  assert.equal(result.needs_review, false);
});

test("delta is zero when stored equals expected across lines", () => {
  const result = computeRefundDelta(4, [1, 1, 2]);
  assert.equal(result.expected, 4);
  assert.equal(result.delta, 0);
  assert.equal(result.needs_repair, false);
  assert.equal(result.needs_review, false);
});
