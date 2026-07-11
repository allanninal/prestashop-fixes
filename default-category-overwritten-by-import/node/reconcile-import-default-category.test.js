import { test } from "node:test";
import assert from "node:assert/strict";
import { decideCategoryRepair } from "./reconcile-import-default-category.js";

test("unchanged default is none", () => {
  const result = decideCategoryRepair(1, null, 5, 5, [1, 5, 9]);
  assert.equal(result.action, "none");
  assert.equal(result.restoreTo, null);
});

test("reset to Home is repair", () => {
  const result = decideCategoryRepair(1, null, 9, 2, [1, 2, 9]);
  assert.equal(result.action, "repair");
  assert.equal(result.restoreTo, 9);
});

test("dropped association is flag not repair", () => {
  const result = decideCategoryRepair(1, null, 9, 2, [1, 2]);
  assert.equal(result.action, "flag");
  assert.equal(result.restoreTo, null);
});

test("ambiguous shift is flag with restore hint", () => {
  const result = decideCategoryRepair(1, null, 9, 12, [1, 9, 12]);
  assert.equal(result.action, "flag");
  assert.equal(result.restoreTo, 9);
});

test("already home moving to another category is flag", () => {
  // preImportDefault === rootCategoryId, so the "reset to Home" branch cannot
  // apply even though postDefault changed.
  const result = decideCategoryRepair(1, null, 2, 12, [1, 2, 12]);
  assert.equal(result.action, "flag");
  assert.equal(result.restoreTo, 2);
});

test("multistore pair is carried through untouched", () => {
  const result = decideCategoryRepair(7, 3, 9, 2, [1, 2, 9]);
  assert.equal(result.productId, 7);
  assert.equal(result.idShop, 3);
  assert.equal(result.action, "repair");
});

test("custom root category id is respected", () => {
  const result = decideCategoryRepair(1, null, 9, 20, [1, 9, 20], 20);
  assert.equal(result.action, "repair");
  assert.equal(result.restoreTo, 9);
});

test("string ids from the webservice are coerced", () => {
  const result = decideCategoryRepair(1, null, "9", "2", ["1", "2", "9"]);
  assert.equal(result.action, "repair");
  assert.equal(result.restoreTo, 9);
});

test("flag when default changes but stays off root and not in associations", () => {
  const result = decideCategoryRepair(1, null, 9, 12, [1, 12]);
  assert.equal(result.action, "flag");
  assert.equal(result.restoreTo, null);
});
