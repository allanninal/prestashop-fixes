import { test } from "node:test";
import assert from "node:assert/strict";
import { recomputeOrderTotal } from "./check-order-total-after-cancel.js";

const line = (over = {}) => ({ total_price_tax_incl: "50.00", ...over });
const rule = (over = {}) => ({ value: "10.00", value_tax_excl: "8.33", deleted: "0", ...over });

test("matches when totals agree", () => {
  const lines = [line({ total_price_tax_incl: "90.00" })];
  const rules = [rule({ value: "10.00", value_tax_excl: "8.33" })];
  const result = recomputeOrderTotal(lines, rules, "5.00", "85.00");
  assert.equal(result.is_mismatched, false);
  assert.equal(result.invalid_discount_shape, false);
});

test("mismatched after line cancelled, voucher stale", () => {
  // One line remains (50.00) plus shipping (5.00), minus a 20.00 voucher sized for the
  // original two-line cart: expected is 50 + 5 - 20 = 35.00, but the order still
  // reports the pre-cancel total of 75.00 because total_paid was never recalculated.
  const lines = [line({ total_price_tax_incl: "50.00" })];
  const rules = [rule({ value: "20.00", value_tax_excl: "16.67" })];
  const result = recomputeOrderTotal(lines, rules, "5.00", "75.00");
  assert.equal(result.is_mismatched, true);
  assert.notEqual(result.delta, 0);
});

test("no voucher no mismatch", () => {
  const lines = [line({ total_price_tax_incl: "50.00" })];
  const result = recomputeOrderTotal(lines, [], "5.00", "55.00");
  assert.equal(result.is_mismatched, false);
});

test("stacked vouchers summed together", () => {
  const lines = [line({ total_price_tax_incl: "100.00" })];
  const rules = [rule({ value: "10.00", value_tax_excl: "8.33" }), rule({ value: "5.00", value_tax_excl: "4.17" })];
  const result = recomputeOrderTotal(lines, rules, "0.00", "85.00");
  assert.equal(result.is_mismatched, false);
});

test("free shipping voucher zeroes shipping reduction", () => {
  const lines = [line({ total_price_tax_incl: "60.00" })];
  const rules = [rule({ value: "8.00", value_tax_excl: "8.00" })];
  const result = recomputeOrderTotal(lines, rules, "8.00", "60.00");
  assert.equal(result.is_mismatched, false);
});

test("deleted cart rule excluded from sum", () => {
  const lines = [line({ total_price_tax_incl: "90.00" })];
  const rules = [rule({ value: "10.00", deleted: "1" }), rule({ value: "5.00", value_tax_excl: "4.17", deleted: "0" })];
  const result = recomputeOrderTotal(lines, rules, "0.00", "85.00");
  assert.equal(result.is_mismatched, false);
});

test("within tolerance not mismatched", () => {
  const lines = [line({ total_price_tax_incl: "90.00" })];
  const rules = [rule({ value: "10.00", value_tax_excl: "8.33" })];
  const result = recomputeOrderTotal(lines, rules, "5.00", "85.01");
  assert.equal(result.is_mismatched, false);
});

test("negative cart rule value is invalid shape", () => {
  const lines = [line({ total_price_tax_incl: "90.00" })];
  const rules = [rule({ value: "-10.00", value_tax_excl: "-8.33" })];
  const result = recomputeOrderTotal(lines, rules, "0.00", "100.00");
  assert.equal(result.invalid_discount_shape, true);
});

test("tax_excl greater than tax_incl is invalid shape", () => {
  const lines = [line({ total_price_tax_incl: "90.00" })];
  const rules = [rule({ value: "10.00", value_tax_excl: "12.00" })];
  const result = recomputeOrderTotal(lines, rules, "0.00", "80.00");
  assert.equal(result.invalid_discount_shape, true);
});
