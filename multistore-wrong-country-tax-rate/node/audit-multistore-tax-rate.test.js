import { test } from "node:test";
import assert from "node:assert/strict";
import { computeExpectedTax, selectApplicableTaxRate } from "./audit-multistore-tax-rate.js";

test("computes expected tax for a basic line", () => {
  assert.equal(computeExpectedTax(100.0, 2, 20.0), 240.0);
});

test("rounds to cents", () => {
  const expected = Math.round(19.99 * 3 * 1.077 * 100) / 100;
  assert.equal(computeExpectedTax(19.99, 3, 7.7), expected);
});

test("handles a zero tax rate", () => {
  assert.equal(computeExpectedTax(50.0, 1, 0.0), 50.0);
});

test("selects the rule matching the order country", () => {
  const rules = [{ id_country: 1, rate: 20.0 }, { id_country: 8, rate: 7.7 }];
  assert.equal(selectApplicableTaxRate(8, 1, rules), 7.7);
});

test("does not fall back to the shop default country when the order country matches", () => {
  const rules = [{ id_country: 1, rate: 20.0 }, { id_country: 8, rate: 7.7 }];
  assert.notEqual(selectApplicableTaxRate(8, 1, rules), 20.0);
});

test("falls back to the shop default country only when no order country rule exists", () => {
  const rules = [{ id_country: 1, rate: 20.0 }];
  assert.equal(selectApplicableTaxRate(8, 1, rules), 20.0);
});

test("returns zero when no rule matches either country", () => {
  const rules = [{ id_country: 99, rate: 15.0 }];
  assert.equal(selectApplicableTaxRate(8, 1, rules), 0);
});

test("order country equal to shop default country still matches", () => {
  const rules = [{ id_country: 1, rate: 20.0 }];
  assert.equal(selectApplicableTaxRate(1, 1, rules), 20.0);
});
