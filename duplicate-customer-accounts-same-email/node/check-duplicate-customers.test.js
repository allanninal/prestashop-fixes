import { test } from "node:test";
import assert from "node:assert/strict";
import { pickMergeAction, normalizeEmail } from "./check-duplicate-customers.js";

const customer = (over = {}) => ({
  id: 1,
  email: "jane@example.com",
  is_guest: "0",
  deleted: "0",
  date_add: "2026-01-01 10:00:00",
  order_count: 0,
  ...over,
});

test("no action for single row", () => {
  assert.equal(pickMergeAction([customer()]), null);
});

test("no action when only one active row", () => {
  const rows = [customer({ id: 1 }), customer({ id: 2, deleted: "1" })];
  assert.equal(pickMergeAction(rows), null);
});

test("keeps row with more orders", () => {
  const rows = [
    customer({ id: 1, order_count: 0 }),
    customer({ id: 2, order_count: 5 }),
  ];
  const action = pickMergeAction(rows);
  assert.equal(action.keep_id, 2);
  assert.deepEqual(action.duplicate_ids, [1]);
});

test("ties broken by registered over guest", () => {
  const rows = [
    customer({ id: 1, is_guest: "1", order_count: 0 }),
    customer({ id: 2, is_guest: "0", order_count: 0 }),
  ];
  const action = pickMergeAction(rows);
  assert.equal(action.keep_id, 2);
  assert.deepEqual(action.duplicate_ids, [1]);
});

test("ties broken by earliest date_add", () => {
  const rows = [
    customer({ id: 1, date_add: "2026-03-01 00:00:00", order_count: 0 }),
    customer({ id: 2, date_add: "2026-01-01 00:00:00", order_count: 0 }),
  ];
  const action = pickMergeAction(rows);
  assert.equal(action.keep_id, 2);
  assert.deepEqual(action.duplicate_ids, [1]);
});

test("deleted rows are ignored", () => {
  const rows = [
    customer({ id: 1, order_count: 3 }),
    customer({ id: 2, deleted: "1", order_count: 9 }),
    customer({ id: 3, order_count: 1 }),
  ];
  const action = pickMergeAction(rows);
  assert.equal(action.keep_id, 1);
  assert.deepEqual(action.duplicate_ids, [3]);
});

test("email carried through from first row", () => {
  const rows = [customer({ id: 1, email: "Jane@Example.com " }), customer({ id: 2, order_count: 1 })];
  const action = pickMergeAction(rows);
  assert.equal(action.email, "Jane@Example.com ");
});

test("normalizeEmail lowers and trims", () => {
  assert.equal(normalizeEmail("  Jane@Example.COM "), "jane@example.com");
});

test("normalizeEmail handles missing input", () => {
  assert.equal(normalizeEmail(undefined), "");
});
