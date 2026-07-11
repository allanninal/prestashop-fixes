import { test } from "node:test";
import assert from "node:assert/strict";
import { findVoucherOveruse } from "./audit-voucher-overuse.js";

const RULE = { id: 42, code: "SUMMER1", quantity: 1, quantityPerUser: 1 };

const order = (over = {}) => ({ idOrder: 1, idCustomer: 10, currentState: 2, dateAdd: "2026-07-01 10:00:00", ...over });

test("no overage when single use is within quantity", () => {
  const orders = [order()];
  assert.equal(findVoucherOveruse(RULE, orders), null);
});

test("overage when quantity one is used twice", () => {
  const orders = [order({ idOrder: 1, idCustomer: 10 }), order({ idOrder: 2, idCustomer: 11 })];
  const result = findVoucherOveruse(RULE, orders);
  assert.ok(result);
  assert.equal(result.overageCount, 1);
  assert.equal(result.totalUses, 2);
  assert.deepEqual(result.offendingOrderIds, [1, 2]);
});

test("per user violation flagged even under total quantity", () => {
  const rule = { id: 7, code: "VIP5", quantity: 5, quantityPerUser: 1 };
  const orders = [order({ idOrder: 1, idCustomer: 10 }), order({ idOrder: 2, idCustomer: 10 })];
  const result = findVoucherOveruse(rule, orders);
  assert.ok(result);
  assert.deepEqual(result.perUserViolations, { 10: 2 });
  assert.equal(result.overageCount, 0);
});

test("no flag when orders list is empty", () => {
  assert.equal(findVoucherOveruse(RULE, []), null);
});

test("offending order ids are sorted", () => {
  const orders = [order({ idOrder: 5, idCustomer: 1 }), order({ idOrder: 2, idCustomer: 2 }), order({ idOrder: 9, idCustomer: 3 })];
  const rule = { id: 8, code: "X", quantity: 1, quantityPerUser: 1 };
  const result = findVoucherOveruse(rule, orders);
  assert.deepEqual(result.offendingOrderIds, [2, 5, 9]);
});

test("guest orders without a customer id are grouped together", () => {
  const orders = [order({ idOrder: 1, idCustomer: null }), order({ idOrder: 2, idCustomer: null })];
  const rule = { id: 9, code: "GUEST1", quantity: 5, quantityPerUser: 1 };
  const result = findVoucherOveruse(rule, orders);
  assert.ok(result);
  assert.deepEqual(result.perUserViolations, { null: 2 });
});

test("exactly at quantity limit is not an overage", () => {
  const rule = { id: 10, code: "EXACT", quantity: 2, quantityPerUser: 2 };
  const orders = [order({ idOrder: 1, idCustomer: 10 }), order({ idOrder: 2, idCustomer: 11 })];
  assert.equal(findVoucherOveruse(rule, orders), null);
});
