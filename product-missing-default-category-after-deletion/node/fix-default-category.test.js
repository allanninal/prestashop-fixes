import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseValidDefaultCategory } from "./fix-default-category.js";

test("no action when default is already valid", () => {
  const result = chooseValidDefaultCategory(10, 5, [5, 6], new Set([5, 6, 2]));
  assert.deepEqual(result, { id_product: 10, action: "none", new_default: 5 });
});

test("reassigns to deepest remaining valid category", () => {
  const result = chooseValidDefaultCategory(11, 99, [3, 7], new Set([2, 3, 7]));
  assert.equal(result.action, "reassign");
  assert.equal(result.old_default, 99);
  assert.equal(result.new_default, 7);
});

test("falls back to root when no valid categories left", () => {
  const result = chooseValidDefaultCategory(12, 99, [], new Set([2, 3, 7]));
  assert.deepEqual(result, { id_product: 12, action: "reassign", old_default: 99, new_default: 2 });
});

test("flags manual when even fallback root is missing", () => {
  const result = chooseValidDefaultCategory(13, 99, [], new Set([3, 7]), 2);
  assert.deepEqual(result, { id_product: 13, action: "flag_manual", old_default: 99, new_default: null });
});

test("ignores associated categories that are also invalid", () => {
  const result = chooseValidDefaultCategory(14, 99, [98, 97], new Set([2, 3]), 2);
  assert.equal(result.action, "reassign");
  assert.equal(result.new_default, 2);
});

test("excludes current default from candidates even if technically valid", () => {
  const result = chooseValidDefaultCategory(15, 99, [99, 6], new Set([6, 2]));
  assert.equal(result.new_default, 6);
});

test("zero default with no categories falls back to root", () => {
  const result = chooseValidDefaultCategory(16, 0, [], new Set([2, 9]));
  assert.deepEqual(result, { id_product: 16, action: "reassign", old_default: 0, new_default: 2 });
});

test("picks max id among multiple valid candidates", () => {
  const result = chooseValidDefaultCategory(17, 50, [4, 12, 8], new Set([2, 4, 8, 12]));
  assert.equal(result.new_default, 12);
});
