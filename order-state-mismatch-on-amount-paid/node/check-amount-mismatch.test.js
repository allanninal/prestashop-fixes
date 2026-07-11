import { test } from "node:test";
import assert from "node:assert/strict";
import { amountMismatch } from "./check-amount-mismatch.js";

const PAID_STATES = new Set([2, 5]);

test("matching amounts are consistent", () => {
  assert.equal(amountMismatch(100.00, 100.00, 2, PAID_STATES), null);
});

test("tiny rounding difference is consistent", () => {
  assert.equal(amountMismatch(99.995, 100.00, 2, PAID_STATES), null);
});

test("partial payment is flagged", () => {
  const result = amountMismatch(100.00, 40.00, 1, PAID_STATES);
  assert.equal(result.reason, "amount_mismatch");
  assert.equal(result.difference, -60.00);
  assert.equal(result.current_state_is_paid, false);
});

test("mismatch on a state flagged as paid is urgent", () => {
  const result = amountMismatch(100.00, 40.00, 2, PAID_STATES);
  assert.equal(result.current_state_is_paid, true);
});

test("overpayment is flagged", () => {
  const result = amountMismatch(100.00, 150.00, 5, PAID_STATES);
  assert.equal(result.difference, 50.00);
  assert.equal(result.current_state_is_paid, true);
});

test("state not in paid set is not urgent", () => {
  const result = amountMismatch(100.00, 40.00, 9, PAID_STATES);
  assert.equal(result.current_state_is_paid, false);
});
