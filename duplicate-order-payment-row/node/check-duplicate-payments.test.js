import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicatePayments } from "./check-duplicate-payments.js";

const payment = (over = {}) => ({
  id: 1,
  order_reference: "ABC123",
  amount: "49.99",
  date_add: "2026-07-10 10:00:00",
  ...over,
});

test("two payments seconds apart is flagged", () => {
  const rows = [
    payment({ id: 1, date_add: "2026-07-10 10:00:00" }),
    payment({ id: 2, date_add: "2026-07-10 10:00:20" }),
  ];
  const clusters = findDuplicatePayments(rows);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].order_reference, "ABC123");
  assert.equal(clusters[0].amount, 49.99);
  assert.equal(clusters[0].count, 2);
  assert.deepEqual(new Set(clusters[0].duplicate_payment_ids), new Set([1, 2]));
});

test("different amounts not flagged", () => {
  const rows = [
    payment({ id: 1, amount: "49.99", date_add: "2026-07-10 10:00:00" }),
    payment({ id: 2, amount: "25.00", date_add: "2026-07-10 10:00:20" }),
  ];
  assert.deepEqual(findDuplicatePayments(rows), []);
});

test("same amount days apart not flagged", () => {
  const rows = [
    payment({ id: 1, amount: "49.99", date_add: "2026-07-10 10:00:00" }),
    payment({ id: 2, amount: "49.99", date_add: "2026-07-13 10:00:00" }),
  ];
  assert.deepEqual(findDuplicatePayments(rows), []);
});

test("single payment not flagged", () => {
  assert.deepEqual(findDuplicatePayments([payment()]), []);
});

test("no payments not flagged", () => {
  assert.deepEqual(findDuplicatePayments([]), []);
});

test("amount within cent tolerance is flagged", () => {
  const rows = [
    payment({ id: 1, amount: "49.990", date_add: "2026-07-10 10:00:00" }),
    payment({ id: 2, amount: "49.995", date_add: "2026-07-10 10:00:05" }),
  ];
  assert.equal(findDuplicatePayments(rows).length, 1);
});

test("unsorted input still detected", () => {
  const rows = [
    payment({ id: 2, date_add: "2026-07-10 10:00:20" }),
    payment({ id: 1, date_add: "2026-07-10 10:00:00" }),
  ];
  const clusters = findDuplicatePayments(rows);
  assert.equal(clusters.length, 1);
});

test("three payments same amount seconds apart forms at least one cluster", () => {
  const rows = [
    payment({ id: 1, date_add: "2026-07-10 10:00:00" }),
    payment({ id: 2, date_add: "2026-07-10 10:00:10" }),
    payment({ id: 3, date_add: "2026-07-10 10:00:20" }),
  ];
  const clusters = findDuplicatePayments(rows);
  assert.ok(clusters.length >= 1);
});
