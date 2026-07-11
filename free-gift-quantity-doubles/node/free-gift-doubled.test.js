import { test } from "node:test";
import assert from "node:assert/strict";
import { findDoubledGiftLines, isPureGiftRow } from "./find-doubled-gift-lines.js";

const GIFT_RULE = { idCartRule: 42, giftProduct: 501, giftProductAttribute: 0, code: "" };

const cartRow = (over = {}) => ({ idProduct: 501, idProductAttribute: 0, quantity: 1, ...over });

test("no finding when gift quantity is one", () => {
  const rows = [cartRow()];
  assert.deepEqual(findDoubledGiftLines(rows, [GIFT_RULE]), []);
});

test("finding when gift quantity doubles", () => {
  const rows = [cartRow({ quantity: 2 })];
  const findings = findDoubledGiftLines(rows, [GIFT_RULE]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].quantity, 2);
  assert.equal(findings[0].idCartRule, 42);
  assert.equal(findings[0].isAutomatic, true);
});

test("no finding when row does not match any gift rule", () => {
  const rows = [cartRow({ idProduct: 999, quantity: 2 })];
  assert.deepEqual(findDoubledGiftLines(rows, [GIFT_RULE]), []);
});

test("no finding when gift product is zero", () => {
  const rule = { idCartRule: 7, giftProduct: 0, giftProductAttribute: 0, code: "" };
  const rows = [cartRow({ quantity: 2 })];
  assert.deepEqual(findDoubledGiftLines(rows, [rule]), []);
});

test("isAutomatic is false when the rule has a code", () => {
  const rule = { idCartRule: 9, giftProduct: 501, giftProductAttribute: 0, code: "SUMMER1" };
  const rows = [cartRow({ quantity: 2 })];
  const findings = findDoubledGiftLines(rows, [rule]);
  assert.equal(findings[0].isAutomatic, false);
});

test("matches on product and attribute pair, not just product", () => {
  const rule = { idCartRule: 5, giftProduct: 501, giftProductAttribute: 3, code: "" };
  const rows = [cartRow({ idProductAttribute: 3, quantity: 2 }), cartRow({ idProductAttribute: 4, quantity: 2 })];
  const findings = findDoubledGiftLines(rows, [rule]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].idProductAttribute, 3);
});

test("no finding when quantity exactly one across multiple rules", () => {
  const rules = [GIFT_RULE, { idCartRule: 6, giftProduct: 777, giftProductAttribute: 0, code: "" }];
  const rows = [cartRow({ quantity: 1 }), cartRow({ idProduct: 777, quantity: 1 })];
  assert.deepEqual(findDoubledGiftLines(rows, rules), []);
});

test("isPureGiftRow is true when only one matching row exists", () => {
  const rows = [cartRow({ quantity: 2 })];
  assert.equal(isPureGiftRow(rows, 501, 0, 2), true);
});

test("isPureGiftRow is false when a separate non-gift row exists", () => {
  const rows = [cartRow({ quantity: 2 }), cartRow({ idProduct: 501, idProductAttribute: 0, quantity: 1 })];
  assert.equal(isPureGiftRow(rows, 501, 0, 2), false);
});

test("isPureGiftRow is false when quantity does not match", () => {
  const rows = [cartRow({ quantity: 3 })];
  assert.equal(isPureGiftRow(rows, 501, 0, 2), false);
});
