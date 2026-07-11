import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOrderCarrier } from "./check-order-carrier.js";

const VALID = new Set([1, 2, 3]);
const DELETED = new Set([5, 6]);

test("ok when carrier is valid", () => {
  assert.equal(classifyOrderCarrier(2, VALID, DELETED), "ok");
});

test("zero when carrier id is zero", () => {
  assert.equal(classifyOrderCarrier(0, VALID, DELETED), "zero");
});

test("zero when carrier id is null", () => {
  assert.equal(classifyOrderCarrier(null, VALID, DELETED), "zero");
});

test("zero when carrier id is undefined", () => {
  assert.equal(classifyOrderCarrier(undefined, VALID, DELETED), "zero");
});

test("deleted when carrier is soft deleted", () => {
  assert.equal(classifyOrderCarrier(5, VALID, DELETED), "deleted");
});

test("missing when carrier is in neither set", () => {
  assert.equal(classifyOrderCarrier(99, VALID, DELETED), "missing");
});

test("ok takes priority when id appears valid only", () => {
  assert.equal(classifyOrderCarrier(1, VALID, DELETED), "ok");
});

test("deleted checked before missing for known dead id", () => {
  assert.equal(classifyOrderCarrier(6, VALID, DELETED), "deleted");
});
