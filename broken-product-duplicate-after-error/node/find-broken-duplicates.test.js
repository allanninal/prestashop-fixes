import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDuplicateIntegrity } from "./find-broken-duplicates.js";

const product = (over = {}) => ({ id: 1, reference: "SKU-1 (copy)", name: "Widget (copy)", active: true, ...over });
const combo = (id) => ({ id, id_product_attribute: id });
const stock = (idProductAttribute) => ({ id_product_attribute: idProductAttribute });

test("OK when not a copy and nothing missing", () => {
  const result = classifyDuplicateIntegrity(product({ reference: "SKU-1", name: "Widget" }), [combo(1)], [], [stock(1)]);
  assert.equal(result, "OK");
});

test("MISSING_COMBINATIONS when copy has none but sibling did", () => {
  const result = classifyDuplicateIntegrity(product(), [], [], [], 3);
  assert.equal(result, "MISSING_COMBINATIONS");
});

test("MISSING_FEATURES when copy has none but expected some", () => {
  const result = classifyDuplicateIntegrity(product({ expected_features: true }), [], [], []);
  assert.equal(result, "MISSING_FEATURES");
});

test("ORPHANED_STOCK when a combination lacks a matching stock row", () => {
  const result = classifyDuplicateIntegrity(product(), [combo(1), combo(2)], [], [stock(1)]);
  assert.equal(result, "ORPHANED_STOCK");
});

test("SUSPECT_PARTIAL_DUPLICATE when fewer combinations than sibling", () => {
  const result = classifyDuplicateIntegrity(product(), [combo(1)], [], [stock(1)], 3);
  assert.equal(result, "SUSPECT_PARTIAL_DUPLICATE");
});

test("OK when copy but combination count matches sibling", () => {
  const result = classifyDuplicateIntegrity(product(), [combo(1), combo(2)], [], [stock(1), stock(2)], 2);
  assert.equal(result, "OK");
});

test("not a copy is never flagged even with fewer combinations", () => {
  const result = classifyDuplicateIntegrity(product({ reference: "SKU-1", name: "Widget" }), [], [], [], 3);
  assert.equal(result, "OK");
});

test("orphaned stock check runs before the partial-duplicate check", () => {
  const result = classifyDuplicateIntegrity(product(), [combo(1), combo(2)], [], [stock(1)], 5);
  assert.equal(result, "ORPHANED_STOCK");
});

test("missing combinations requires a positive sibling count", () => {
  const result = classifyDuplicateIntegrity(product(), [], [], [], 0);
  assert.equal(result, "OK");
});
