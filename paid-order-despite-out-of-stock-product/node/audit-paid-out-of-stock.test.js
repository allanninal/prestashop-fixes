import { test } from "node:test";
import assert from "node:assert/strict";
import { decideOutOfStockPaidFlag } from "./audit-paid-out-of-stock.js";

const PAID_IDS = [2, 12];

test("paid, qty zero, deny is flagged", () => {
  const lines = [{ productId: 1, productAttributeId: 0, productQuantity: 1 }];
  const stock = new Map([["1:0", { quantity: 0, outOfStock: 0 }]]);
  const result = decideOutOfStockPaidFlag({ orderId: 101, currentStateId: 2, paidStateIds: PAID_IDS, orderLines: lines, stockByLineKey: stock });
  assert.equal(result.flagged, true);
  assert.equal(result.reasons.length, 1);
});

test("paid, qty five, deny is not flagged", () => {
  const lines = [{ productId: 1, productAttributeId: 0, productQuantity: 1 }];
  const stock = new Map([["1:0", { quantity: 5, outOfStock: 0 }]]);
  const result = decideOutOfStockPaidFlag({ orderId: 102, currentStateId: 2, paidStateIds: PAID_IDS, orderLines: lines, stockByLineKey: stock });
  assert.equal(result.flagged, false);
});

test("paid, negative qty, allow backorder is not flagged", () => {
  const lines = [{ productId: 1, productAttributeId: 0, productQuantity: 1 }];
  const stock = new Map([["1:0", { quantity: -2, outOfStock: 1 }]]);
  const result = decideOutOfStockPaidFlag({ orderId: 103, currentStateId: 2, paidStateIds: PAID_IDS, orderLines: lines, stockByLineKey: stock });
  assert.equal(result.flagged, false);
});

test("not paid is never flagged regardless of stock", () => {
  const lines = [{ productId: 1, productAttributeId: 0, productQuantity: 1 }];
  const stock = new Map([["1:0", { quantity: -5, outOfStock: 0 }]]);
  const result = decideOutOfStockPaidFlag({ orderId: 104, currentStateId: 1, paidStateIds: PAID_IDS, orderLines: lines, stockByLineKey: stock });
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

test("multiple lines, one insufficient, flags with one reason", () => {
  const lines = [
    { productId: 1, productAttributeId: 0, productQuantity: 1 },
    { productId: 2, productAttributeId: 0, productQuantity: 2 },
  ];
  const stock = new Map([
    ["1:0", { quantity: 10, outOfStock: 0 }],
    ["2:0", { quantity: 0, outOfStock: 0 }],
  ]);
  const result = decideOutOfStockPaidFlag({ orderId: 105, currentStateId: 12, paidStateIds: PAID_IDS, orderLines: lines, stockByLineKey: stock });
  assert.equal(result.flagged, true);
  assert.equal(result.reasons.length, 1);
  assert.ok(result.reasons[0].includes("2:0"));
});

test("quantity exactly equals needed is not flagged", () => {
  const lines = [{ productId: 1, productAttributeId: 0, productQuantity: 3 }];
  const stock = new Map([["1:0", { quantity: 3, outOfStock: 0 }]]);
  const result = decideOutOfStockPaidFlag({ orderId: 106, currentStateId: 2, paidStateIds: PAID_IDS, orderLines: lines, stockByLineKey: stock });
  assert.equal(result.flagged, false);
});
