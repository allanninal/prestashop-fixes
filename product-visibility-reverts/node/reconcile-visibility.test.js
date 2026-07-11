import { test } from "node:test";
import assert from "node:assert/strict";
import { decideVisibilityAction } from "./reconcile-visibility.js";

test("no action when actual matches intended", () => {
  const result = decideVisibilityAction({ "1:1": "none" }, { "1:1": "none" }, new Set());
  assert.equal(result[0].action, "none");
});

test("reapply when drifted and never repaired", () => {
  const result = decideVisibilityAction({ "1:1": "none" }, { "1:1": "both" }, new Set());
  assert.equal(result[0].action, "reapply");
  assert.equal(result[0].intended, "none");
  assert.equal(result[0].actual, "both");
});

test("flag when drifted again after a repair", () => {
  const result = decideVisibilityAction({ "1:1": "none" }, { "1:1": "both" }, new Set(["1:1"]));
  assert.equal(result[0].action, "flag");
});

test("missing actual value is treated as drift", () => {
  const result = decideVisibilityAction({ "2:3": "catalog" }, {}, new Set());
  assert.equal(result[0].action, "reapply");
  assert.equal(result[0].actual, null);
});

test("handles multiple pairs independently", () => {
  const intended = { "1:1": "none", "2:1": "search", "3:1": "both" };
  const actual = { "1:1": "both", "2:1": "search", "3:1": "both" };
  const result = decideVisibilityAction(intended, actual, new Set(["1:1"]));
  const byKey = Object.fromEntries(result.map((d) => [`${d.productId}:${d.idShop}`, d.action]));
  assert.equal(byKey["1:1"], "flag");
  assert.equal(byKey["2:1"], "none");
  assert.equal(byKey["3:1"], "none");
});

test("returns one decision per intended key", () => {
  const intended = { "1:1": "none", "1:2": "both" };
  const actual = { "1:1": "none", "1:2": "both" };
  const result = decideVisibilityAction(intended, actual, new Set());
  assert.equal(result.length, 2);
});

test("no network or side effects, pure function", () => {
  const intended = { "9:1": "search" };
  const actual = { "9:1": "search" };
  const first = decideVisibilityAction(intended, actual, new Set());
  const second = decideVisibilityAction(intended, actual, new Set());
  assert.deepEqual(first, second);
});

test("key not present in alreadyRepairedOnce defaults to reapply", () => {
  const result = decideVisibilityAction({ "4:2": "search" }, { "4:2": "none" }, new Set(["9:9"]));
  assert.equal(result[0].action, "reapply");
});
