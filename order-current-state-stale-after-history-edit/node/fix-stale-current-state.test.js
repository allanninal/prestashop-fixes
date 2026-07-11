import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCorrectCurrentState } from "./fix-stale-current-state.js";

const row = (id, id_order_state, date_add) => ({ id, id_order_state, date_add });

test("empty history returns null", () => {
  assert.equal(computeCorrectCurrentState([]), null);
});

test("single row returns its state", () => {
  assert.equal(computeCorrectCurrentState([row(1, 2, "2026-07-01 10:00:00")]), 2);
});

test("picks most recent by date_add", () => {
  const rows = [row(1, 1, "2026-07-01 10:00:00"), row(2, 2, "2026-07-05 10:00:00")];
  assert.equal(computeCorrectCurrentState(rows), 2);
});

test("out of order input still picks latest", () => {
  const rows = [row(3, 5, "2026-07-09 10:00:00"), row(1, 1, "2026-07-01 10:00:00"), row(2, 2, "2026-07-05 10:00:00")];
  assert.equal(computeCorrectCurrentState(rows), 5);
});

test("tie on date_add breaks by highest id", () => {
  const rows = [row(10, 3, "2026-07-05 10:00:00"), row(11, 4, "2026-07-05 10:00:00")];
  assert.equal(computeCorrectCurrentState(rows), 4);
});

test("row with missing date_add sorts first", () => {
  const rows = [row(1, 9, null), row(2, 2, "2026-07-01 10:00:00")];
  assert.equal(computeCorrectCurrentState(rows), 2);
});

test("identical date_add and id are stable", () => {
  const rows = [row(7, 3, "2026-07-05 10:00:00"), row(7, 3, "2026-07-05 10:00:00")];
  assert.equal(computeCorrectCurrentState(rows), 3);
});

test("many rows all same date breaks by max id", () => {
  const rows = [row(1, 1, "2026-07-05 10:00:00"), row(5, 9, "2026-07-05 10:00:00"), row(3, 4, "2026-07-05 10:00:00")];
  assert.equal(computeCorrectCurrentState(rows), 9);
});
