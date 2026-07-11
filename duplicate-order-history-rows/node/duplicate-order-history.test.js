import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicateHistoryIds } from "./duplicate-history-cleanup.js";

const row = (id, id_order_state, date_add) => ({ id, id_order_state, date_add });

test("no rows means no duplicates", () => {
  assert.deepEqual(findDuplicateHistoryIds([]), []);
});

test("no duplicates when all states differ", () => {
  const rows = [row(1, 1, "2026-07-10 10:00:00"), row(2, 2, "2026-07-10 10:05:00")];
  assert.deepEqual(findDuplicateHistoryIds(rows), []);
});

test("consecutive same state is flagged", () => {
  const rows = [row(1, 2, "2026-07-10 10:00:00"), row(2, 2, "2026-07-10 10:00:05")];
  assert.deepEqual(findDuplicateHistoryIds(rows), [2]);
});

test("first occurrence is never flagged", () => {
  const rows = [row(1, 2, "2026-07-10 10:00:00"), row(2, 2, "2026-07-10 10:00:05")];
  const duplicateIds = findDuplicateHistoryIds(rows);
  assert.equal(duplicateIds.includes(1), false);
});

test("revisiting the same state later is not flagged", () => {
  const rows = [
    row(1, 1, "2026-07-10 09:00:00"),
    row(2, 2, "2026-07-10 09:05:00"),
    row(3, 3, "2026-07-10 09:10:00"),
    row(4, 1, "2026-07-10 09:15:00"),
  ];
  assert.deepEqual(findDuplicateHistoryIds(rows), []);
});

test("a run longer than two flags all but the first", () => {
  const rows = [
    row(1, 2, "2026-07-10 10:00:00"),
    row(2, 2, "2026-07-10 10:00:01"),
    row(3, 2, "2026-07-10 10:00:02"),
  ];
  assert.deepEqual(findDuplicateHistoryIds(rows), [2, 3]);
});

test("unsorted input is sorted before comparing", () => {
  const rows = [
    row(2, 2, "2026-07-10 10:00:05"),
    row(1, 2, "2026-07-10 10:00:00"),
  ];
  assert.deepEqual(findDuplicateHistoryIds(rows), [2]);
});

test("three separate runs are each flagged independently", () => {
  const rows = [
    row(1, 1, "2026-07-10 09:00:00"),
    row(2, 1, "2026-07-10 09:00:01"),
    row(3, 2, "2026-07-10 09:05:00"),
    row(4, 2, "2026-07-10 09:05:01"),
  ];
  assert.deepEqual(findDuplicateHistoryIds(rows), [2, 4]);
});
