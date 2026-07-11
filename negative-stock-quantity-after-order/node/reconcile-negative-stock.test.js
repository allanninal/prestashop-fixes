import { test } from "node:test";
import assert from "node:assert/strict";
import { decideStockReconciliation } from "./reconcile-negative-stock.js";

test("not negative needs no fix", () => {
  const result = decideStockReconciliation(5, 1, 1, true);
  assert.equal(result.needsFix, false);
  assert.equal(result.newQuantity, null);
  assert.equal(result.reason, "not negative");
});

test("zero quantity needs no fix", () => {
  const result = decideStockReconciliation(0, 1, 0, true);
  assert.equal(result.needsFix, false);
  assert.equal(result.reason, "not negative");
});

test("negative but not stock tracked is benign", () => {
  const result = decideStockReconciliation(-3, 0, 2, true);
  assert.equal(result.needsFix, false);
  assert.equal(result.newQuantity, null);
  assert.ok(result.reason.includes("benign"));
});

test("negative with a non-1 depends_on_stock value is benign", () => {
  const result = decideStockReconciliation(-1, 2, 1, true);
  assert.equal(result.needsFix, false);
});

test("negative and stock tracked needs fix in dry run", () => {
  const result = decideStockReconciliation(-1, 1, 1, true);
  assert.equal(result.needsFix, true);
  assert.equal(result.newQuantity, null);
  assert.equal(result.reason, "negative tracked stock from oversell; clamp to zero");
});

test("negative and stock tracked clamps when not dry run", () => {
  const result = decideStockReconciliation(-4, 1, 1, false);
  assert.equal(result.needsFix, true);
  assert.equal(result.newQuantity, 0);
  assert.equal(result.reason, "negative tracked stock from oversell; clamp to zero");
});

test("large negative still flagged", () => {
  const result = decideStockReconciliation(-999, 1, 0, false);
  assert.equal(result.needsFix, true);
  assert.equal(result.newQuantity, 0);
});
