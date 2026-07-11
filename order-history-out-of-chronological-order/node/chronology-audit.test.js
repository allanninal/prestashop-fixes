import { test } from "node:test";
import assert from "node:assert/strict";
import { findChronologyViolation } from "./chronology-audit.js";

const row = (id, id_order_state, date_add) => ({ id, id_order_state, date_add });

test("no rows means no violation", () => {
  assert.equal(findChronologyViolation([], 2), null);
});

test("agreeing current_state has no violation", () => {
  const rows = [row(1, 1, "2026-07-10 10:00:00"), row(2, 2, "2026-07-10 10:05:00")];
  assert.equal(findChronologyViolation(rows, 2), null);
});

test("current_state mismatch is detected", () => {
  const rows = [row(1, 1, "2026-07-10 10:00:00"), row(2, 3, "2026-07-10 10:05:00")];
  const result = findChronologyViolation(rows, 2);
  assert.equal(result.reason, "current_state_mismatch");
  assert.equal(result.latest_history_state, 3);
  assert.equal(result.current_state, 2);
  assert.equal(result.latest_id, 2);
});

test("id is used as tiebreaker to pick the latest state", () => {
  // Same date_add: id determines the true latest row (id 6, state 4), so
  // current_state=4 matches the tiebreak-selected latest row. But since the
  // two rows also share an identical date_add with differing states, that is
  // itself flagged as an ambiguous-order case for manual review.
  const rows = [row(5, 3, "2026-07-10 10:00:00"), row(6, 4, "2026-07-10 10:00:00")];
  const result = findChronologyViolation(rows, 4);
  assert.equal(result.reason, "duplicate_timestamp_ambiguous_order");
});

test("duplicate timestamp with wrong current_state still reports mismatch", () => {
  const rows = [row(5, 3, "2026-07-10 10:00:00"), row(6, 4, "2026-07-10 10:00:00")];
  const result = findChronologyViolation(rows, 3);
  assert.equal(result.reason, "current_state_mismatch");
});

test("duplicate timestamp flagged even when state agrees elsewhere", () => {
  const rows = [
    row(1, 1, "2026-07-10 09:00:00"),
    row(2, 2, "2026-07-10 10:00:00"),
    row(3, 5, "2026-07-10 10:00:00"),
  ];
  const result = findChronologyViolation(rows, 5);
  assert.equal(result.reason, "duplicate_timestamp_ambiguous_order");
  assert.equal(result.rows.length, 2);
});

test("out of input order rows are sorted correctly", () => {
  const rows = [
    row(3, 6, "2026-07-10 11:00:00"),
    row(1, 4, "2026-07-10 09:00:00"),
    row(2, 5, "2026-07-10 10:00:00"),
  ];
  assert.equal(findChronologyViolation(rows, 6), null);
  const result = findChronologyViolation(rows, 5);
  assert.equal(result.reason, "current_state_mismatch");
  assert.equal(result.latest_history_state, 6);
  assert.equal(result.latest_id, 3);
});

test("single row matching current_state has no violation", () => {
  const rows = [row(1, 2, "2026-07-10 09:00:00")];
  assert.equal(findChronologyViolation(rows, 2), null);
});

test("single row mismatched current_state is a violation", () => {
  const rows = [row(1, 2, "2026-07-10 09:00:00")];
  const result = findChronologyViolation(rows, 9);
  assert.equal(result.reason, "current_state_mismatch");
  assert.equal(result.latest_id, 1);
});
