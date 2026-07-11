import { test } from "node:test";
import assert from "node:assert/strict";
import { isProductAtRiskOfDelisting } from "./detect-and-repair-delisted-products.js";

test("healthy product is not at risk", () => {
  const [atRisk, reasons] = isProductAtRiskOfDelisting("1", "both", 3, [2, 3], 12, 0);
  assert.equal(atRisk, false);
  assert.deepEqual(reasons, []);
});

test("flags when inactive", () => {
  const [atRisk, reasons] = isProductAtRiskOfDelisting("0", "both", 3, [2, 3], 12, 0);
  assert.equal(atRisk, true);
  assert.ok(reasons.some((r) => r.includes("active")));
});

test("flags when visibility is none", () => {
  const [atRisk, reasons] = isProductAtRiskOfDelisting("1", "none", 3, [2, 3], 12, 0);
  assert.equal(atRisk, true);
  assert.ok(reasons.some((r) => r.includes("visibility")));
});

test("visibility catalog is allowed", () => {
  const [atRisk] = isProductAtRiskOfDelisting("1", "catalog", 3, [2, 3], 12, 0);
  assert.equal(atRisk, false);
});

test("flags when id_category_default is zero", () => {
  const [atRisk, reasons] = isProductAtRiskOfDelisting("1", "both", 0, [2, 3], 12, 0);
  assert.equal(atRisk, true);
  assert.ok(reasons.some((r) => r.includes("id_category_default is 0")));
});

test("flags when category ids empty", () => {
  const [atRisk, reasons] = isProductAtRiskOfDelisting("1", "both", 3, [], 12, 0);
  assert.equal(atRisk, true);
  assert.ok(reasons.some((r) => r.includes("empty")));
});

test("flags when default category not in category ids", () => {
  const [atRisk, reasons] = isProductAtRiskOfDelisting("1", "both", 9, [2, 3], 12, 0);
  assert.equal(atRisk, true);
  assert.ok(reasons.some((r) => r.includes("not in associations.categories")));
});

test("flags when out of stock and denying orders", () => {
  const [atRisk, reasons] = isProductAtRiskOfDelisting("1", "both", 3, [2, 3], 0, 2);
  assert.equal(atRisk, true);
  assert.ok(reasons.some((r) => r.includes("out of stock")));
});

test("out of stock but backorder allowed is not flagged for stock", () => {
  const [atRisk] = isProductAtRiskOfDelisting("1", "both", 3, [2, 3], 0, 1);
  assert.equal(atRisk, false);
});

test("multiple reasons can stack", () => {
  const [atRisk, reasons] = isProductAtRiskOfDelisting("0", "none", 0, [], 0, 2);
  assert.equal(atRisk, true);
  assert.equal(reasons.length, 5);
});
