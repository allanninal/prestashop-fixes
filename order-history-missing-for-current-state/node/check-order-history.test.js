import { test } from "node:test";
import assert from "node:assert/strict";
import { needsHistoryBackfill } from "./check-order-history.js";

test("empty history needs backfill", () => {
  const result = needsHistoryBackfill(2, []);
  assert.deepEqual(result, { reason: "no_history", expected_state: 2 });
});

test("matching latest state is consistent", () => {
  const history = [[1, "2026-07-01 10:00:00"], [2, "2026-07-02 10:00:00"]];
  assert.equal(needsHistoryBackfill(2, history), null);
});

test("mismatched latest state needs backfill", () => {
  const history = [[1, "2026-07-01 10:00:00"], [2, "2026-07-02 10:00:00"]];
  const result = needsHistoryBackfill(3, history);
  assert.deepEqual(result, {
    reason: "state_mismatch",
    expected_state: 3,
    last_recorded_state: 2,
    last_recorded_date: "2026-07-02 10:00:00",
  });
});

test("uses latest by date regardless of input order", () => {
  const history = [[2, "2026-07-02 10:00:00"], [1, "2026-07-01 10:00:00"], [5, "2026-07-05 10:00:00"]];
  assert.equal(needsHistoryBackfill(5, history), null);
});

test("single history row matching is consistent", () => {
  assert.equal(needsHistoryBackfill(1, [[1, "2026-07-01 10:00:00"]]), null);
});

test("single history row mismatched needs backfill", () => {
  const result = needsHistoryBackfill(4, [[1, "2026-07-01 10:00:00"]]);
  assert.equal(result.reason, "state_mismatch");
  assert.equal(result.last_recorded_state, 1);
});

test("no history expected_state matches current_state", () => {
  const result = needsHistoryBackfill(7, []);
  assert.equal(result.expected_state, 7);
});
