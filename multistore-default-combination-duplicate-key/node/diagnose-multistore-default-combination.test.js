import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDefaultCombinationState } from "./diagnose-multistore-default-combination.js";

const combo = (over = {}) => ({ id: 1, id_product_attribute: 10, default_on: "0", ...over });

test("not applicable when no combinations", () => {
  assert.equal(classifyDefaultCombinationState([], null, true), "NOT_APPLICABLE");
});

test("ok when exactly one default matches the pointer", () => {
  const combos = [combo({ id_product_attribute: 10, default_on: "1" }), combo({ id_product_attribute: 11, default_on: "0" })];
  assert.equal(classifyDefaultCombinationState(combos, 10, true), "OK");
});

test("duplicate default when two rows are flagged", () => {
  const combos = [combo({ id_product_attribute: 10, default_on: "1" }), combo({ id_product_attribute: 11, default_on: "1" })];
  assert.equal(classifyDefaultCombinationState(combos, 10, true), "DUPLICATE_DEFAULT");
});

test("missing default on an active shop", () => {
  const combos = [combo({ id_product_attribute: 10, default_on: "0" }), combo({ id_product_attribute: 11, default_on: "0" })];
  assert.equal(classifyDefaultCombinationState(combos, null, true), "MISSING_DEFAULT");
});

test("missing default ignored on an inactive shop", () => {
  const combos = [combo({ id_product_attribute: 10, default_on: "0" })];
  assert.equal(classifyDefaultCombinationState(combos, null, false), "NOT_APPLICABLE");
});

test("pointer mismatch when the product points elsewhere", () => {
  const combos = [combo({ id_product_attribute: 10, default_on: "1" })];
  assert.equal(classifyDefaultCombinationState(combos, 99, true), "POINTER_MISMATCH");
});

test("ok when pointer is null and one default exists", () => {
  const combos = [combo({ id_product_attribute: 10, default_on: "1" })];
  assert.equal(classifyDefaultCombinationState(combos, null, true), "OK");
});

test("duplicate wins over pointer mismatch", () => {
  const combos = [combo({ id_product_attribute: 10, default_on: "1" }), combo({ id_product_attribute: 11, default_on: "1" })];
  assert.equal(classifyDefaultCombinationState(combos, 999, true), "DUPLICATE_DEFAULT");
});

test("not applicable ignores pointer when shop inactive and no default", () => {
  const combos = [combo({ id_product_attribute: 10, default_on: "0" }), combo({ id_product_attribute: 11, default_on: "0" })];
  assert.equal(classifyDefaultCombinationState(combos, 10, false), "NOT_APPLICABLE");
});
