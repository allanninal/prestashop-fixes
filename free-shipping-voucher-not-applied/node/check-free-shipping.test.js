import { test } from "node:test";
import assert from "node:assert/strict";
import { decideFreeShippingViolation } from "./check-free-shipping.js";

const DATE_FROM = "2026-07-01 00:00:00";
const DATE_TO = "2026-07-31 23:59:59";

const cartRule = (over = {}) => ({
  id: 7,
  code: "FREESHIP",
  active: true,
  free_shipping: true,
  carrier_restriction: null,
  date_from: DATE_FROM,
  date_to: DATE_TO,
  ...over,
});

const order = (over = {}) => ({
  id_carrier: 2,
  date_add: "2026-07-15 10:00:00",
  total_shipping_tax_incl: "5.99",
  ...over,
});

test("flags when eligible and shipping nonzero", () => {
  assert.equal(decideFreeShippingViolation(cartRule(), order(), {}), true);
});

test("no violation when shipping already zero", () => {
  assert.equal(decideFreeShippingViolation(cartRule(), order({ total_shipping_tax_incl: "0.00" }), {}), false);
});

test("no violation when rule inactive", () => {
  assert.equal(decideFreeShippingViolation(cartRule({ active: false }), order(), {}), false);
});

test("no violation when free_shipping not set", () => {
  assert.equal(decideFreeShippingViolation(cartRule({ free_shipping: false }), order(), {}), false);
});

test("no violation when order date outside window", () => {
  assert.equal(decideFreeShippingViolation(cartRule(), order({ date_add: "2026-08-05 00:00:00" }), {}), false);
});

test("no violation when carrier excluded by restriction", () => {
  const rule = cartRule({ carrier_restriction: [3, 4] });
  assert.equal(decideFreeShippingViolation(rule, order({ id_carrier: 2 }), {}), false);
});

test("flags when carrier is in restriction list", () => {
  const rule = cartRule({ carrier_restriction: [2, 3] });
  assert.equal(decideFreeShippingViolation(rule, order({ id_carrier: 2 }), {}), true);
});

test("no violation when missing order date", () => {
  assert.equal(decideFreeShippingViolation(cartRule(), order({ date_add: null }), {}), false);
});

test("exactly at date_to is still eligible", () => {
  assert.equal(decideFreeShippingViolation(cartRule(), order({ date_add: DATE_TO }), {}), true);
});

test("exactly at date_from is still eligible", () => {
  assert.equal(decideFreeShippingViolation(cartRule(), order({ date_add: DATE_FROM }), {}), true);
});
