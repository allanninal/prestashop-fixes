import { test } from "node:test";
import assert from "node:assert/strict";
import { findDefaultCategoryDrift, assignedCategoryIds } from "./flag-default-category-drift.js";

test("flags when default is not in assigned ids", () => {
  const drift = findDefaultCategoryDrift(9, [1, 2, 3]);
  assert.deepEqual(drift, { idCategoryDefault: 9, validCategoryIds: [1, 2, 3] });
});

test("no flag when default is assigned", () => {
  assert.equal(findDefaultCategoryDrift(2, [1, 2, 3]), null);
});

test("no flag when default is null or undefined", () => {
  assert.equal(findDefaultCategoryDrift(null, [1, 2, 3]), null);
  assert.equal(findDefaultCategoryDrift(undefined, [1, 2, 3]), null);
});

test("flags with empty validCategoryIds when assigned list is empty", () => {
  const drift = findDefaultCategoryDrift(5, []);
  assert.deepEqual(drift, { idCategoryDefault: 5, validCategoryIds: [] });
});

test("validCategoryIds are sorted and deduplicated", () => {
  const drift = findDefaultCategoryDrift(9, [3, 1, 2, 1, 3]);
  assert.deepEqual(drift, { idCategoryDefault: 9, validCategoryIds: [1, 2, 3] });
});

test("accepts string ids from the webservice", () => {
  assert.equal(findDefaultCategoryDrift("2", ["1", "2", "3"]), null);
  const drift = findDefaultCategoryDrift("9", ["1", "2", "3"]);
  assert.deepEqual(drift, { idCategoryDefault: 9, validCategoryIds: [1, 2, 3] });
});

test("assignedCategoryIds reads the webservice shape", () => {
  const product = { associations: { categories: { category: [{ id: "1" }, { id: "2" }] } } };
  assert.deepEqual(assignedCategoryIds(product), [1, 2]);
});

test("assignedCategoryIds handles missing associations", () => {
  assert.deepEqual(assignedCategoryIds({}), []);
});
