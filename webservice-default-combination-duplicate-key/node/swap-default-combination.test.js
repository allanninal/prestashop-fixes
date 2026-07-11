import { test } from "node:test";
import assert from "node:assert/strict";
import { planDefaultSwap, currentDefaultId } from "./swap-default-combination.js";

const row = (over = {}) => ({ id: 1, default_on: 0, ...over });

test("no steps when target is already default", () => {
  assert.deepEqual(planDefaultSwap(5, 5), []);
});

test("clears old default before setting the new one", () => {
  const steps = planDefaultSwap(5, 9);
  assert.deepEqual(steps, [{ id: 5, default_on: 0 }, { id: 9, default_on: 1 }]);
});

test("order is always clear then set", () => {
  const steps = planDefaultSwap(3, 4);
  assert.equal(steps[0].default_on, 0);
  assert.equal(steps[1].default_on, 1);
  assert.notEqual(steps[0].id, steps[1].id);
});

test("handles a missing current default", () => {
  assert.deepEqual(planDefaultSwap(null, 7), [{ id: 7, default_on: 1 }]);
});

test("currentDefaultId finds the flagged row", () => {
  const rows = [row({ id: 1, default_on: 0 }), row({ id: 2, default_on: 1 }), row({ id: 3, default_on: 0 })];
  assert.equal(currentDefaultId(rows), 2);
});

test("currentDefaultId returns null when nobody is flagged", () => {
  const rows = [row({ id: 1, default_on: 0 }), row({ id: 2, default_on: 0 })];
  assert.equal(currentDefaultId(rows), null);
});

test("currentDefaultId on an empty list", () => {
  assert.equal(currentDefaultId([]), null);
});

test("plan is idempotent when rerun after a swap", () => {
  const first = planDefaultSwap(5, 9);
  assert.ok(first.length > 0);
  const second = planDefaultSwap(9, 9);
  assert.deepEqual(second, []);
});
