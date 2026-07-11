import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBestSpecificPrice, findPriceMismatch } from "./check-specific-price-priority.js";

const BASE_PRICE = 100.0;
const NOW = "2026-07-10 12:00:00";

const rule = (over = {}) => ({
  idGroup: 0, idCurrency: 0, idCountry: 0, idCustomer: 0,
  reduction: 0, reductionType: "amount", fromQuantity: 1,
  from: null, to: null,
  ...over,
});

const context = (over = {}) => ({
  customerGroupIds: [12], currencyId: 1, countryId: 1,
  customerId: 501, quantity: 1, now: NOW,
  ...over,
});

test("narrow group row beats all groups row when both match", () => {
  const rules = [
    rule({ idGroup: 0, reduction: 10 }),   // all groups, price 90
    rule({ idGroup: 12, reduction: 11 }),  // this customer's group, price 89
  ];
  const result = resolveBestSpecificPrice(BASE_PRICE, rules, context());
  assert.equal(result.bestPrice, 89.0);
  assert.equal(result.winningRuleIndex, 1);
});

test("rule scoped to a different group is ignored", () => {
  const rules = [rule({ idGroup: 99, reduction: 50 })];
  const result = resolveBestSpecificPrice(BASE_PRICE, rules, context());
  assert.equal(result.bestPrice, BASE_PRICE);
  assert.equal(result.winningRuleIndex, null);
});

test("percentage reduction is computed correctly", () => {
  const rules = [rule({ idGroup: 0, reduction: 0.20, reductionType: "percentage" })];
  const result = resolveBestSpecificPrice(BASE_PRICE, rules, context());
  assert.equal(result.bestPrice, 80.0);
});

test("currency mismatch excludes the rule", () => {
  const rules = [rule({ idGroup: 0, idCurrency: 2, reduction: 50 })];
  const result = resolveBestSpecificPrice(BASE_PRICE, rules, context({ currencyId: 1 }));
  assert.equal(result.winningRuleIndex, null);
});

test("country mismatch excludes the rule", () => {
  const rules = [rule({ idGroup: 0, idCountry: 9, reduction: 50 })];
  const result = resolveBestSpecificPrice(BASE_PRICE, rules, context({ countryId: 1 }));
  assert.equal(result.winningRuleIndex, null);
});

test("specific customer rule matches only that customer", () => {
  const rules = [rule({ idGroup: 0, idCustomer: 501, reduction: 25 })];
  const result = resolveBestSpecificPrice(BASE_PRICE, rules, context({ customerId: 501 }));
  assert.equal(result.bestPrice, 75.0);

  const other = resolveBestSpecificPrice(BASE_PRICE, rules, context({ customerId: 999 }));
  assert.equal(other.winningRuleIndex, null);
});

test("from_quantity tier excludes when quantity too low", () => {
  const rules = [rule({ idGroup: 0, reduction: 30, fromQuantity: 5 })];
  const result = resolveBestSpecificPrice(BASE_PRICE, rules, context({ quantity: 1 }));
  assert.equal(result.winningRuleIndex, null);
});

test("from_quantity tier included when quantity meets tier", () => {
  const rules = [rule({ idGroup: 0, reduction: 30, fromQuantity: 5 })];
  const result = resolveBestSpecificPrice(BASE_PRICE, rules, context({ quantity: 5 }));
  assert.equal(result.bestPrice, 70.0);
});

test("expired date window excludes the rule", () => {
  const rules = [rule({ idGroup: 0, reduction: 30, to: "2020-01-01 00:00:00" })];
  const result = resolveBestSpecificPrice(BASE_PRICE, rules, context());
  assert.equal(result.winningRuleIndex, null);
});

test("not yet started date window excludes the rule", () => {
  const rules = [rule({ idGroup: 0, reduction: 30, from: "2099-01-01 00:00:00" })];
  const result = resolveBestSpecificPrice(BASE_PRICE, rules, context());
  assert.equal(result.winningRuleIndex, null);
});

test("zero date is treated as unbounded", () => {
  const rules = [rule({ idGroup: 0, reduction: 15, from: "0000-00-00 00:00:00", to: "0000-00-00 00:00:00" })];
  const result = resolveBestSpecificPrice(BASE_PRICE, rules, context());
  assert.equal(result.bestPrice, 85.0);
});

test("no matching rule returns base price", () => {
  const result = resolveBestSpecificPrice(BASE_PRICE, [], context());
  assert.equal(result.bestPrice, BASE_PRICE);
  assert.equal(result.winningRuleIndex, null);
});

test("findPriceMismatch flags when store served a worse price", () => {
  assert.equal(findPriceMismatch(89.0, 90.0), true);
});

test("findPriceMismatch ignores rounding epsilon", () => {
  assert.equal(findPriceMismatch(89.995, 90.0), false);
});

test("findPriceMismatch false when store agrees", () => {
  assert.equal(findPriceMismatch(89.0, 89.0), false);
});

test("findPriceMismatch false when store serves a better price", () => {
  assert.equal(findPriceMismatch(89.0, 85.0), false);
});
