import { test } from "node:test";
import assert from "node:assert/strict";
import { findShippingMismatches, reconcileReferenceTotal } from "./check-split-shipping.js";

const order = (over = {}) => ({
  id: 101, reference: "ABCDEFGHI", id_carrier: 3,
  total_shipping_tax_incl: "5.00", total_paid_tax_incl: "55.00",
  ...over,
});

const carrierRow = (over = {}) => ({
  id_order: 101, id_carrier: 3, shipping_cost_tax_incl: "5.00", id_order_invoice: 1,
  ...over,
});

test("no mismatch when everything agrees", () => {
  assert.deepEqual(findShippingMismatches([order()], [carrierRow()]), []);
});

test("missing carrier row with nonzero shipping is flagged", () => {
  const result = findShippingMismatches([order({ id_carrier: 0 })], []);
  assert.equal(result.length, 1);
  assert.equal(result[0].reason, "missing_carrier_with_nonzero_shipping");
});

test("zero shipping but carrier row has cost is flagged", () => {
  const o = order({ id_carrier: 0, total_shipping_tax_incl: "0.00" });
  const result = findShippingMismatches([o], [carrierRow()]);
  assert.equal(result.length, 1);
  assert.equal(result[0].reason, "zero_shipping_with_carrier_assigned");
});

test("carrier id mismatch is flagged", () => {
  const result = findShippingMismatches([order({ id_carrier: 7 })], [carrierRow({ id_carrier: 3 })]);
  assert.equal(result.length, 1);
  assert.equal(result[0].reason, "carrier_id_mismatch");
});

test("shipping cost mismatch is flagged", () => {
  const result = findShippingMismatches([order({ total_shipping_tax_incl: "12.00" })], [carrierRow({ shipping_cost_tax_incl: "5.00" })]);
  assert.equal(result.length, 1);
  assert.equal(result[0].reason, "shipping_cost_mismatch");
});

test("small rounding difference is not flagged", () => {
  const result = findShippingMismatches([order({ total_shipping_tax_incl: "5.004" })], [carrierRow({ shipping_cost_tax_incl: "5.00" })]);
  assert.deepEqual(result, []);
});

test("order with no carriers and zero shipping is not flagged", () => {
  const result = findShippingMismatches([order({ id_carrier: 0, total_shipping_tax_incl: "0.00" })], []);
  assert.deepEqual(result, []);
});

test("reconcileReferenceTotal matches", () => {
  const orders = [
    order({ id: 101, total_products_wt: "50.00", total_shipping_tax_incl: "5.00", total_discounts_tax_incl: "0.00", total_paid_tax_incl: "55.00" }),
    order({ id: 102, total_products_wt: "20.00", total_shipping_tax_incl: "8.00", total_discounts_tax_incl: "0.00", total_paid_tax_incl: "28.00" }),
  ];
  const [sumPaid, expected] = reconcileReferenceTotal(orders);
  assert.equal(sumPaid, 83.00);
  assert.equal(expected, 83.00);
});

test("reconcileReferenceTotal detects mismatch", () => {
  const orders = [
    order({ id: 101, total_products_wt: "50.00", total_shipping_tax_incl: "0.00", total_discounts_tax_incl: "0.00", total_paid_tax_incl: "60.00" }),
    order({ id: 102, total_products_wt: "20.00", total_shipping_tax_incl: "13.00", total_discounts_tax_incl: "0.00", total_paid_tax_incl: "33.00" }),
  ];
  const [sumPaid, expected] = reconcileReferenceTotal(orders);
  assert.equal(sumPaid, 93.00);
  assert.equal(expected, 83.00);
});
