import { test } from "node:test";
import assert from "node:assert/strict";
import { computeReservedDrift } from "./reserved-quantity-drift.js";

const LOGABLE = new Set([2]);

const line = (over = {}) => ({
  id_product: 10,
  id_product_attribute: 0,
  product_quantity: 2,
  product_quantity_refunded: 0,
  id_order_state: 2,
  ...over,
});

const stockRow = (over = {}) => ({ id_product: 10, id_product_attribute: 0, reserved_quantity: 2, ...over });

test("no drift when expected matches actual", () => {
  assert.deepEqual(computeReservedDrift([line()], LOGABLE, [stockRow()]), []);
});

test("drift when reserved_quantity stuck after cancellation", () => {
  const result = computeReservedDrift([], LOGABLE, [stockRow({ reserved_quantity: 3 })]);
  assert.deepEqual(result, [{
    id_product: 10,
    id_product_attribute: 0,
    expected_reserved: 0,
    actual_reserved: 3,
    drift: 3,
  }]);
});

test("zero orders and zero stock produces no drift", () => {
  assert.deepEqual(computeReservedDrift([], LOGABLE, []), []);
});

test("refunded partial line reduces expected reserved", () => {
  const l = line({ product_quantity: 5, product_quantity_refunded: 3 });
  assert.deepEqual(computeReservedDrift([l], LOGABLE, [stockRow({ reserved_quantity: 2 })]), []);
  assert.deepEqual(computeReservedDrift([l], LOGABLE, [stockRow({ reserved_quantity: 5 })]), [{
    id_product: 10,
    id_product_attribute: 0,
    expected_reserved: 2,
    actual_reserved: 5,
    drift: 3,
  }]);
});

test("non-logable state is excluded from expected", () => {
  const l = line({ id_order_state: 99 });
  const result = computeReservedDrift([l], LOGABLE, [stockRow({ reserved_quantity: 2 })]);
  assert.deepEqual(result, [{
    id_product: 10,
    id_product_attribute: 0,
    expected_reserved: 0,
    actual_reserved: 2,
    drift: 2,
  }]);
});

test("multiple attributes per product are tracked separately", () => {
  const lines = [
    line({ id_product_attribute: 1, product_quantity: 1 }),
    line({ id_product_attribute: 2, product_quantity: 4 }),
  ];
  const rows = [
    stockRow({ id_product_attribute: 1, reserved_quantity: 1 }),
    stockRow({ id_product_attribute: 2, reserved_quantity: 9 }),
  ];
  const result = computeReservedDrift(lines, LOGABLE, rows);
  assert.deepEqual(result, [{
    id_product: 10,
    id_product_attribute: 2,
    expected_reserved: 4,
    actual_reserved: 9,
    drift: 5,
  }]);
});

test("negative remaining is clipped to zero", () => {
  const l = line({ product_quantity: 2, product_quantity_refunded: 5 });
  const result = computeReservedDrift([l], LOGABLE, [stockRow({ reserved_quantity: 0 })]);
  assert.deepEqual(result, []);
});
