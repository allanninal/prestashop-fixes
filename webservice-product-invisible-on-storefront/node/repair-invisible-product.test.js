import { test } from "node:test";
import assert from "node:assert/strict";
import { decideProductRepair } from "./repair-invisible-product.js";

const product = (over = {}) => ({
  active: 1,
  visibility: "both",
  id_category_default: 5,
  associations: { categories: [5], shops: [1] },
  ...over,
});

const context = (over = {}) => ({ expectedShopIds: [1], validCategoryIds: [2, 5], ...over });

test("ok when everything is wired up", () => {
  const result = decideProductRepair(product(), context());
  assert.equal(result.status, "ok");
  assert.equal(result.patch, null);
});

test("ok when inactive regardless of associations", () => {
  const p = product({ active: 0, associations: { categories: [], shops: [] } });
  const result = decideProductRepair(p, context());
  assert.equal(result.status, "ok");
});

test("needs repair when categories empty", () => {
  const p = product({ associations: { categories: [], shops: [1] } });
  const result = decideProductRepair(p, context());
  assert.equal(result.status, "needs_repair");
  assert.ok(result.missing.includes("categories"));
  assert.deepEqual(result.patch.associations.categories, [5]);
});

test("needs repair when default category not in categories", () => {
  const p = product({ associations: { categories: [2], shops: [1] } });
  const result = decideProductRepair(p, context());
  assert.equal(result.status, "needs_repair");
  assert.ok(result.missing.includes("id_category_default_not_in_categories"));
  assert.deepEqual([...result.patch.associations.categories].sort(), [2, 5]);
});

test("needs repair when shops empty", () => {
  const p = product({ associations: { categories: [5], shops: [] } });
  const result = decideProductRepair(p, context());
  assert.equal(result.status, "needs_repair");
  assert.ok(result.missing.includes("shops"));
  assert.deepEqual(result.patch.associations.shops, [1]);
});

test("needs repair when shops missing expected id", () => {
  const p = product({ associations: { categories: [5], shops: [9] } });
  const result = decideProductRepair(p, context({ expectedShopIds: [1, 2] }));
  assert.equal(result.status, "needs_repair");
  assert.ok(result.missing.includes("shops"));
});

test("needs repair when visibility none", () => {
  const p = product({ visibility: "none" });
  const result = decideProductRepair(p, context());
  assert.equal(result.status, "needs_repair");
  assert.ok(result.missing.includes("visibility"));
  assert.equal(result.patch.visibility, "both");
});

test("unrepairable when default category invalid", () => {
  const p = product({ id_category_default: 999 });
  const result = decideProductRepair(p, context());
  assert.equal(result.status, "unrepairable");
  assert.ok(result.missing.includes("default_category_invalid"));
  assert.equal(result.patch, null);
});

test("unrepairable wins even with other missing pieces", () => {
  const p = product({ id_category_default: 999, associations: { categories: [], shops: [] } });
  const result = decideProductRepair(p, context());
  assert.equal(result.status, "unrepairable");
  assert.equal(result.patch, null);
});

test("multiple missing pieces combine into one patch", () => {
  const p = product({ visibility: "none", associations: { categories: [], shops: [] } });
  const result = decideProductRepair(p, context());
  assert.equal(result.status, "needs_repair");
  assert.deepEqual([...result.missing].sort(), ["categories", "shops", "visibility"]);
  assert.deepEqual(result.patch.associations.categories, [5]);
  assert.deepEqual(result.patch.associations.shops, [1]);
  assert.equal(result.patch.visibility, "both");
});
