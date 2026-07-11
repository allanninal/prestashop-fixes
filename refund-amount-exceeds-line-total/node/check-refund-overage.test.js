import { test } from "node:test";
import assert from "node:assert/strict";
import { isRefundOverage, wouldNewRefundOvershoot } from "./check-refund-overage.js";

test("exact match is not overage", () => {
  const result = isRefundOverage(2, 2, 100.00, 100.00);
  assert.equal(result.overage, false);
  assert.equal(result.quantity_overage, 0);
  assert.equal(result.amount_overage, 0.0);
});

test("one cent rounding is not overage", () => {
  const result = isRefundOverage(2, 2, 100.00, 100.01);
  assert.equal(result.overage, false);
});

test("quantity overage is flagged", () => {
  const result = isRefundOverage(2, 3, 100.00, 100.00);
  assert.equal(result.overage, true);
  assert.equal(result.quantity_overage, 1);
  assert.equal(result.amount_overage, 0.0);
});

test("amount overage is flagged", () => {
  const result = isRefundOverage(2, 2, 100.00, 150.00);
  assert.equal(result.overage, true);
  assert.equal(result.quantity_overage, 0);
  assert.equal(result.amount_overage, 50.00);
});

test("zero quantity line with refund is flagged", () => {
  const result = isRefundOverage(0, 1, 0.00, 25.00);
  assert.equal(result.overage, true);
  assert.equal(result.quantity_overage, 1);
  assert.equal(result.amount_overage, 25.00);
});

test("negative refunded amount is not overage", () => {
  const result = isRefundOverage(2, 0, 100.00, -10.00);
  assert.equal(result.overage, false);
  assert.equal(result.amount_overage, 0.0);
});

test("custom epsilon is respected", () => {
  const result = isRefundOverage(2, 2, 100.00, 100.03, 0.05);
  assert.equal(result.overage, false);
});

test("both quantity and amount overage are reported together", () => {
  const result = isRefundOverage(1, 2, 50.00, 120.00);
  assert.equal(result.overage, true);
  assert.equal(result.quantity_overage, 1);
  assert.equal(result.amount_overage, 70.00);
});

test("guard rejects request over remaining quantity", () => {
  assert.equal(wouldNewRefundOvershoot(2, 1, 100.00, 50.00, 2, 50.00), true);
});

test("guard rejects request over remaining amount", () => {
  assert.equal(wouldNewRefundOvershoot(2, 0, 100.00, 0.00, 1, 150.00), true);
});

test("guard allows request within remaining balance", () => {
  assert.equal(wouldNewRefundOvershoot(2, 1, 100.00, 50.00, 1, 50.00), false);
});

test("guard allows exact remaining balance within epsilon", () => {
  assert.equal(wouldNewRefundOvershoot(2, 0, 100.00, 0.00, 2, 100.00), false);
});
