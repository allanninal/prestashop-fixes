import { test } from "node:test";
import assert from "node:assert/strict";
import { isOverAssociated, unintendedShopIds, resolvedShopIds } from "./flag-category-shop-scope.js";

test("flags when associated with every shop but one expected", () => {
  const category = { id: 10, id_shop_default: 1, associations: { shops: [{ id: 1 }, { id: 2 }, { id: 3 }] } };
  assert.equal(isOverAssociated(category, new Set([1]), new Set([1, 2, 3])), true);
});

test("no flag when associated matches expected exactly", () => {
  const category = { id: 11, id_shop_default: 1, associations: { shops: [{ id: 1 }] } };
  assert.equal(isOverAssociated(category, new Set([1]), new Set([1, 2, 3])), false);
});

test("no flag when expected covers all shops", () => {
  const category = { id: 12, id_shop_default: 1, associations: { shops: [{ id: 1 }, { id: 2 }, { id: 3 }] } };
  assert.equal(isOverAssociated(category, new Set([1, 2, 3]), new Set([1, 2, 3])), false);
});

test("falls back to id_shop_default when no associations node", () => {
  const category = { id: 13, id_shop_default: 2 };
  assert.deepEqual(resolvedShopIds(category), new Set([2]));
  assert.equal(isOverAssociated(category, new Set([1]), new Set([1, 2, 3])), true);
});

test("no flag when no shop signal at all", () => {
  const category = { id: 14 };
  assert.equal(isOverAssociated(category, new Set([1]), new Set([1, 2, 3])), false);
});

test("unintendedShopIds reports the diff", () => {
  const category = { id: 15, id_shop_default: 1, associations: { shops: [{ id: 1 }, { id: 2 }, { id: 3 }] } };
  assert.deepEqual(unintendedShopIds(category, new Set([1])), new Set([2, 3]));
});

test("two expected shops narrower than all is flagged", () => {
  const category = { id: 16, id_shop_default: 1, associations: { shops: [{ id: 1 }, { id: 2 }, { id: 3 }] } };
  assert.equal(isOverAssociated(category, new Set([1, 2]), new Set([1, 2, 3])), true);
});

test("empty associations list falls back to default", () => {
  const category = { id: 17, id_shop_default: 1, associations: { shops: [] } };
  assert.deepEqual(resolvedShopIds(category), new Set([1]));
});

test("not over associated when subset of expected", () => {
  const category = { id: 18, id_shop_default: 1, associations: { shops: [{ id: 1 }] } };
  assert.equal(isOverAssociated(category, new Set([1, 2, 3]), new Set([1, 2, 3])), false);
});
