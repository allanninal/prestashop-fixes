import { test } from "node:test";
import assert from "node:assert/strict";
import { decideDefaultCombination } from "./fix-default-combination.js";

const combo = (over = {}) => ({ id: 5, id_product: 10, active: "1", price: "12.00", ...over });

test("no action when default is valid and active", () => {
  const result = decideDefaultCombination(10, 5, [combo({ id: 5 })]);
  assert.equal(result.action, "none");
});

test("repairs when default id is zero", () => {
  const result = decideDefaultCombination(10, 0, [combo({ id: 5, price: "9.00" }), combo({ id: 6, price: "15.00" })]);
  assert.equal(result.action, "repair");
  assert.equal(result.targetId, 5);
});

test("repairs when default id is blank", () => {
  const result = decideDefaultCombination(10, "", [combo({ id: 7 })]);
  assert.equal(result.action, "repair");
  assert.equal(result.targetId, 7);
});

test("repairs when default points at deleted combination", () => {
  const result = decideDefaultCombination(10, 99, [combo({ id: 5 })]);
  assert.equal(result.action, "repair");
  assert.equal(result.targetId, 5);
});

test("repairs when default points at inactive combination", () => {
  const result = decideDefaultCombination(10, 5, [combo({ id: 5, active: "0" }), combo({ id: 6, active: "1" })]);
  assert.equal(result.action, "repair");
  assert.equal(result.targetId, 6);
});

test("ignores combination belonging to a different product", () => {
  const result = decideDefaultCombination(10, 5, [combo({ id: 5, id_product: 99 })]);
  assert.equal(result.action, "flag");
});

test("flags when no eligible combination exists", () => {
  const result = decideDefaultCombination(10, 0, [combo({ id: 5, active: "0" })]);
  assert.equal(result.action, "flag");
  assert.equal(result.targetId, null);
});

test("picks cheapest among multiple eligible combinations", () => {
  const combos = [combo({ id: 1, price: "20.00" }), combo({ id: 2, price: "8.50" }), combo({ id: 3, price: "14.00" })];
  const result = decideDefaultCombination(10, 0, combos);
  assert.equal(result.targetId, 2);
});

test("repairs when default id is null", () => {
  const result = decideDefaultCombination(10, null, [combo({ id: 5 })]);
  assert.equal(result.action, "repair");
  assert.equal(result.targetId, 5);
});
