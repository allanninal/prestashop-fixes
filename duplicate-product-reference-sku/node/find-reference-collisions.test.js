import { test } from "node:test";
import assert from "node:assert/strict";
import { findReferenceCollisions, findCombinationReferenceCollisions } from "./find-reference-collisions.js";

const product = (over = {}) => ({ id: 1, reference: "SKU-123", name: "Widget", active: true, ...over });

test("no collision when references are unique", () => {
  const products = [product({ id: 1, reference: "SKU-1" }), product({ id: 2, reference: "SKU-2" })];
  assert.deepEqual(findReferenceCollisions(products), {});
});

test("finds a collision for the same reference on two ids", () => {
  const products = [product({ id: 45, name: "Red shirt" }), product({ id: 812, name: "Blue shirt" })];
  const result = findReferenceCollisions(products);
  assert.deepEqual(Object.keys(result), ["SKU-123"]);
  assert.deepEqual(result["SKU-123"].map((p) => p.id), [45, 812]);
});

test("blank reference is not a collision", () => {
  const products = [product({ id: 1, reference: "" }), product({ id: 2, reference: "" })];
  assert.deepEqual(findReferenceCollisions(products), {});
});

test("whitespace-only reference is treated as blank", () => {
  const products = [product({ id: 1, reference: "   " }), product({ id: 2, reference: "   " })];
  assert.deepEqual(findReferenceCollisions(products), {});
});

test("reference is normalized by trimming before grouping", () => {
  const products = [product({ id: 1, reference: "SKU-123" }), product({ id: 2, reference: "  SKU-123  " })];
  const result = findReferenceCollisions(products);
  assert.equal(result["SKU-123"].length, 2);
});

test("a single product with a reference is not a collision", () => {
  const products = [product({ id: 1, reference: "SKU-1" })];
  assert.deepEqual(findReferenceCollisions(products), {});
});

test("three-way collision keeps all ids sorted", () => {
  const products = [product({ id: 30 }), product({ id: 5 }), product({ id: 17 })];
  const result = findReferenceCollisions(products);
  assert.deepEqual(result["SKU-123"].map((p) => p.id), [5, 17, 30]);
});

test("missing reference key is treated as blank", () => {
  const products = [{ id: 1, name: "A", active: true }, { id: 2, name: "B", active: true }];
  assert.deepEqual(findReferenceCollisions(products), {});
});

test("combination references are grouped the same way", () => {
  const combinations = [
    { id: 10, id_product: 5, reference: "VAR-9" },
    { id: 11, id_product: 6, reference: "VAR-9" },
  ];
  const result = findCombinationReferenceCollisions(combinations);
  assert.deepEqual(Object.keys(result), ["VAR-9"]);
  assert.deepEqual(result["VAR-9"].map((c) => c.id), [10, 11]);
});

test("combination blank reference is not a collision", () => {
  const combinations = [
    { id: 10, id_product: 5, reference: "" },
    { id: 11, id_product: 6, reference: "" },
  ];
  assert.deepEqual(findCombinationReferenceCollisions(combinations), {});
});
