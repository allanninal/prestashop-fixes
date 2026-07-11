import { test } from "node:test";
import assert from "node:assert/strict";
import { isCombinationStockOrphaned } from "./stock-update-deletes-combination.js";

const pre = (over = {}) => ({ id_product_attribute: 5, existed: true, quantity: 10, ...over });
const post = (over = {}) => ({ id_shop: 0, id_shop_group: 2, quantity: 10, id_product_attribute: 5, ...over });
const group = (over = {}) => ({ id_shop_group: 2, share_stock: true, ...over });

test("not orphaned when scope and quantity are fine", () => {
  assert.equal(isCombinationStockOrphaned(pre(), post(), group()), false);
});

test("not orphaned when combination never existed", () => {
  assert.equal(isCombinationStockOrphaned(pre({ existed: false }), post({ id_shop: 1 }), group()), false);
});

test("not orphaned when group does not share stock", () => {
  assert.equal(isCombinationStockOrphaned(pre(), post({ id_shop: 1 }), group({ share_stock: false })), false);
});

test("orphaned when scope drifted off zero", () => {
  assert.equal(isCombinationStockOrphaned(pre(), post({ id_shop: 1 }), group()), true);
});

test("orphaned when quantity collapsed to zero", () => {
  assert.equal(isCombinationStockOrphaned(pre({ quantity: 10 }), post({ quantity: 0 }), group()), true);
});

test("not orphaned when quantity was already zero", () => {
  assert.equal(isCombinationStockOrphaned(pre({ quantity: 0 }), post({ quantity: 0 }), group()), false);
});

test("orphaned when both scope drifted and quantity collapsed", () => {
  assert.equal(isCombinationStockOrphaned(pre({ quantity: 10 }), post({ id_shop: 1, quantity: 0 }), group()), true);
});

test("not orphaned when shop group id differs but still shares stock", () => {
  assert.equal(
    isCombinationStockOrphaned(pre(), post({ id_shop: 0, id_shop_group: 9 }), group({ id_shop_group: 9 })),
    false
  );
});
