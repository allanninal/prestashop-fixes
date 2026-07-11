import { test } from "node:test";
import assert from "node:assert/strict";
import { findRefundOverage } from "./check-refund-overage.js";

const line = (over = {}) => ({
  id: 1,
  id_order: 100,
  product_id: 55,
  product_quantity: 3,
  product_quantity_refunded: 2,
  product_quantity_return: 0,
  product_quantity_reinjected: 0,
  ...over,
});

test("no finding when refunded within ordered", () => {
  assert.deepEqual(findRefundOverage([line()]), []);
});

test("flags refunded exceeding ordered", () => {
  const findings = findRefundOverage([line({ product_quantity: 3, product_quantity_refunded: 5 })]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reason, "refunded_exceeds_ordered");
  assert.equal(findings[0].ordered, 3);
  assert.equal(findings[0].refunded, 5);
  assert.equal(findings[0].overage, 2);
});

test("flags returned exceeding ordered", () => {
  const findings = findRefundOverage([line({ product_quantity: 2, product_quantity_return: 4 })]);
  assert.ok(findings.some((f) => f.reason === "returned_exceeds_ordered"));
});

test("flags reinjected exceeding refunded", () => {
  const findings = findRefundOverage([line({ product_quantity_refunded: 2, product_quantity_reinjected: 3 })]);
  assert.ok(findings.some((f) => f.reason === "reinjected_exceeds_refunded"));
});

test("sorted by overage descending", () => {
  const lines = [
    line({ id: 1, product_quantity: 10, product_quantity_refunded: 11 }),
    line({ id: 2, product_quantity: 3, product_quantity_refunded: 8 }),
  ];
  const findings = findRefundOverage(lines);
  assert.deepEqual(findings.map((f) => f.id), [2, 1]);
});

test("equal refunded and ordered is not flagged", () => {
  assert.deepEqual(findRefundOverage([line({ product_quantity: 3, product_quantity_refunded: 3 })]), []);
});

test("multiple lines only flags the bad one", () => {
  const lines = [line({ id: 1 }), line({ id: 2, product_quantity: 1, product_quantity_refunded: 4 })];
  const findings = findRefundOverage(lines);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, 2);
});

test("no findings for empty input", () => {
  assert.deepEqual(findRefundOverage([]), []);
});

test("missing optional fields default to zero", () => {
  const minimal = {
    id: 9,
    id_order: 200,
    product_id: 7,
    product_quantity: 5,
    product_quantity_refunded: 5,
  };
  assert.deepEqual(findRefundOverage([minimal]), []);
});
