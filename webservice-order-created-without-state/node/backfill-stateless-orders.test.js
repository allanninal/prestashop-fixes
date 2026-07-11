import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBackfillState } from "./backfill-stateless-orders.js";

const STATES = [
  { id: "1", name: "Awaiting check payment", logable: "1", hidden: "0" },
  { id: "2", name: "Payment accepted", logable: "1", hidden: "0" },
  { id: "3", name: "Awaiting bank wire payment", logable: "1", hidden: "0" },
  { id: "6", name: "Canceled", logable: "0", hidden: "0" },
  { id: "7", name: "Refunded", logable: "0", hidden: "1" },
];

const order = (over = {}) => ({
  id_order: 42,
  current_state: 0,
  total_paid: 100.0,
  total_paid_real: 0.0,
  payment: "Bank wire",
  valid: false,
  ...over,
});

test("returns null when current_state is already set", () => {
  assert.equal(resolveBackfillState(order({ current_state: 2 }), STATES), null);
});

test("resolves paid state when fully paid", () => {
  assert.equal(resolveBackfillState(order({ total_paid_real: 100.0 }), STATES), 2);
});

test("resolves paid state when overpaid", () => {
  assert.equal(resolveBackfillState(order({ total_paid_real: 105.0 }), STATES), 2);
});

test("resolves lowest awaiting state when unpaid", () => {
  assert.equal(resolveBackfillState(order(), STATES), 1);
});

test("returns null when no awaiting states exist", () => {
  const noAwaiting = STATES.filter((s) => !/wire|check/i.test(s.name));
  assert.equal(resolveBackfillState(order(), noAwaiting), null);
});

test("returns null when no logable states exist", () => {
  const hiddenOnly = STATES.map((s) => ({ ...s, logable: "0" }));
  assert.equal(resolveBackfillState(order({ total_paid_real: 100.0 }), hiddenOnly), null);
});

test("returns null when current_state is 0 and no states given", () => {
  assert.equal(resolveBackfillState(order({ current_state: 0 }), []), null);
});

test("zero total paid falls back to awaiting", () => {
  assert.equal(resolveBackfillState(order({ total_paid: 0.0, total_paid_real: 0.0 }), STATES), 1);
});

test("returns null when multiple paid states match", () => {
  const ambiguous = [...STATES, { id: "8", name: "Payment accepted by proxy", logable: "1", hidden: "0" }];
  assert.equal(resolveBackfillState(order({ total_paid_real: 100.0 }), ambiguous), null);
});
