import { test } from "node:test";
import assert from "node:assert/strict";
import { findOrphans } from "./find-orphaned-categories.js";

const cat = (id, idParent) => ({ id, id_parent: idParent, is_root_category: false });

test("reachable tree has no orphans", () => {
  const categories = [cat(2, 1), cat(3, 1), cat(4, 2)];
  const result = findOrphans(categories, new Set([1]), []);
  assert.deepEqual(result.orphaned_categories, []);
});

test("category pointing at deleted parent is orphaned", () => {
  const categories = [cat(2, 1), cat(3, 99)];
  const result = findOrphans(categories, new Set([1]), []);
  assert.deepEqual(result.orphaned_categories, [3]);
});

test("whole orphaned branch is flagged", () => {
  const categories = [cat(2, 1), cat(3, 99), cat(4, 3)];
  const result = findOrphans(categories, new Set([1]), []);
  assert.deepEqual(result.orphaned_categories, [3, 4]);
});

test("root ids are never flagged", () => {
  const categories = [cat(2, 1)];
  const result = findOrphans(categories, new Set([1, 2]), []);
  assert.deepEqual(result.orphaned_categories, []);
});

test("cycle outside root is orphaned", () => {
  const categories = [cat(2, 1), cat(3, 4), cat(4, 3)];
  const result = findOrphans(categories, new Set([1]), []);
  assert.deepEqual([...result.orphaned_categories].sort(), [3, 4]);
});

test("product with only orphaned category is flagged", () => {
  const categories = [cat(2, 1), cat(3, 99)];
  const products = [{ id: 501, id_category_default: 3, category_ids: [3] }];
  const result = findOrphans(categories, new Set([1]), products);
  assert.deepEqual(result.orphaned_products, [501]);
});

test("product reachable through any category is not flagged", () => {
  const categories = [cat(2, 1), cat(3, 99)];
  const products = [{ id: 502, id_category_default: 3, category_ids: [3, 2] }];
  const result = findOrphans(categories, new Set([1]), products);
  assert.deepEqual(result.orphaned_products, []);
});

test("product with no category signal at all is flagged", () => {
  const categories = [cat(2, 1)];
  const products = [{ id: 503, id_category_default: null, category_ids: [] }];
  const result = findOrphans(categories, new Set([1]), products);
  assert.deepEqual(result.orphaned_products, [503]);
});

test("product reachable through default category is not flagged", () => {
  const categories = [cat(2, 1)];
  const products = [{ id: 504, id_category_default: 2, category_ids: [] }];
  const result = findOrphans(categories, new Set([1]), products);
  assert.deepEqual(result.orphaned_products, []);
});

test("multiple shop roots are all respected", () => {
  const categories = [cat(11, 10), cat(21, 20), cat(31, 99)];
  const result = findOrphans(categories, new Set([10, 20]), []);
  assert.deepEqual(result.orphaned_categories, [31]);
});
