import { test } from "node:test";
import assert from "node:assert/strict";
import { decideOrderPaymentRepair, computedCartTotal } from "./reconcile-payment-error.js";

const order = (over = {}) => ({ id: 101, total_paid: 100.00, total_paid_real: 0.0, current_state: 8, ...over });

test("totals reconciled when everything matches", () => {
  const result = decideOrderPaymentRepair(order(), { amount: 100.00 }, 100.00);
  assert.equal(result.action, "none");
  assert.equal(result.reason, "totals_reconciled");
});

test("flags missing order payment row", () => {
  const result = decideOrderPaymentRepair(order(), null, 100.00);
  assert.equal(result.action, "flag_manual_review");
  assert.equal(result.reason, "no_order_payment_row_found");
});

test("flags when order total diverges from cart", () => {
  const result = decideOrderPaymentRepair(order({ total_paid: 100.00 }), { amount: 100.00 }, 85.00);
  assert.equal(result.action, "flag_manual_review");
  assert.equal(result.reason, "order_total_paid_diverges_from_cart_total");
});

test("corrects payment amount when order total is right but payment row is not", () => {
  const result = decideOrderPaymentRepair(order({ total_paid: 100.00 }), { amount: 40.00 }, 100.00);
  assert.equal(result.action, "correct_payment_amount");
  assert.equal(result.correctedAmount, 100.00);
});

test("tiny rounding within precision is treated as equal", () => {
  const result = decideOrderPaymentRepair(order({ total_paid: 100.004 }), { amount: 100.00 }, 100.001);
  assert.equal(result.action, "none");
});

test("respects custom precision", () => {
  const result = decideOrderPaymentRepair(order({ total_paid: 100.0 }), { amount: 100.0 }, 100.0, 0);
  assert.equal(result.action, "none");
});

test("overpayment on matching order total is corrected", () => {
  const result = decideOrderPaymentRepair(order({ total_paid: 100.00 }), { amount: 150.00 }, 100.00);
  assert.equal(result.action, "correct_payment_amount");
  assert.equal(result.correctedAmount, 100.00);
});

test("negative difference diverging from cart is flagged not corrected", () => {
  const result = decideOrderPaymentRepair(order({ total_paid: 120.00 }), { amount: 120.00 }, 100.00);
  assert.equal(result.action, "flag_manual_review");
});

test("computedCartTotal sums products and shipping and subtracts discounts", () => {
  const total = computedCartTotal({ total_products_wt: "80.00", total_shipping: "20.00", total_discounts: "5.00" });
  assert.equal(total, 95.00);
});

test("computedCartTotal defaults missing fields to zero", () => {
  const total = computedCartTotal({});
  assert.equal(total, 0);
});
