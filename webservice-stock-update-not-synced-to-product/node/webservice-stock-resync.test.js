import { test } from "node:test";
import assert from "node:assert/strict";
import { decideReconciliation } from "./webservice-stock-resync.js";

test("in sync when values match", () => {
  assert.deepEqual(decideReconciliation(10, 10, 0, 1), { status: "in_sync", action: "none", delta: 0 });
});

test("stuck zero resyncs when depends on stock", () => {
  assert.deepEqual(decideReconciliation(0, 25, 0, 1), { status: "stuck_zero", action: "resync_display_only", delta: 25 });
});

test("stuck zero flags when not depends on stock", () => {
  assert.deepEqual(decideReconciliation(0, 25, 0, 0), { status: "stuck_zero", action: "flag_for_review", delta: 25 });
});

test("stale product field resyncs when depends on stock", () => {
  assert.deepEqual(decideReconciliation(8, 12, 0, 1), { status: "stale_product_field", action: "resync_display_only", delta: 4 });
});

test("stale product field flags when not depends on stock", () => {
  assert.deepEqual(decideReconciliation(8, 12, 0, 0), { status: "stale_product_field", action: "flag_for_review", delta: 4 });
});

test("negative delta is stale product field not stuck zero", () => {
  assert.deepEqual(decideReconciliation(20, 5, 0, 1), { status: "stale_product_field", action: "resync_display_only", delta: -15 });
});

test("zero and zero is in sync", () => {
  assert.deepEqual(decideReconciliation(0, 0, 0, 1), { status: "in_sync", action: "none", delta: 0 });
});

test("out of stock flag does not change the decision", () => {
  const a = decideReconciliation(0, 5, 0, 1);
  const b = decideReconciliation(0, 5, 2, 1);
  assert.deepEqual(a, { status: "stuck_zero", action: "resync_display_only", delta: 5 });
  assert.deepEqual(a, b);
});
