import { test } from "node:test";
import assert from "node:assert/strict";
import { decideQuantitySync } from "./sync-stock-quantity.js";

test("legacy field never trusted even when nonzero", () => {
  const result = decideQuantitySync(99, 5, true, "both", true);
  assert.equal(result.status, "ignore_legacy_field");
  assert.equal(result.action, "none");
});

test("flags when no stock_availables row found", () => {
  const result = decideQuantitySync(0, null, true, "both", true);
  assert.equal(result.action, "flag");
  assert.match(result.reason, /no stock_availables row/);
});

test("no action when real quantity is healthy", () => {
  const result = decideQuantitySync(0, 12, true, "both", true);
  assert.equal(result.action, "none");
});

test("flags zero stock on active visible product when expected positive", () => {
  const result = decideQuantitySync(0, 0, true, "both", true, true);
  assert.equal(result.action, "flag");
});

test("no repair when product is inactive", () => {
  const result = decideQuantitySync(0, 0, false, "both", true, true);
  assert.equal(result.action, "none");
});

test("no repair when visibility is none", () => {
  const result = decideQuantitySync(0, 0, true, "none", true, true);
  assert.equal(result.action, "none");
});

test("patches when dry run off and target known", () => {
  const result = decideQuantitySync(0, 0, true, "both", false, true, 10);
  assert.equal(result.action, "patch_stock_available");
  assert.equal(result.targetQuantity, 10);
});

test("flags instead of patching when dry run on", () => {
  const result = decideQuantitySync(0, 0, true, "both", true, true, 10);
  assert.equal(result.action, "flag");
});

test("flags instead of patching when target quantity unknown", () => {
  const result = decideQuantitySync(0, 0, true, "both", false, true, null);
  assert.equal(result.action, "flag");
});

test("negative real quantity on active visible product is flagged", () => {
  const result = decideQuantitySync(0, -3, true, "catalog", true, true);
  assert.equal(result.action, "flag");
});
