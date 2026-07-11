import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicateInvoiceNumbers } from "./check-duplicate-invoice-numbers.js";

const invoice = (over = {}) => ({
  id: 1,
  id_order: 100,
  number: 1042,
  date_add: "2026-07-10 10:00:00",
  ...over,
});

test("no collisions", () => {
  const rows = [
    invoice({ id: 1, id_order: 100, number: 1042 }),
    invoice({ id: 2, id_order: 101, number: 1043 }),
  ];
  assert.deepEqual(findDuplicateInvoiceNumbers(rows), []);
});

test("one collision pair", () => {
  const rows = [
    invoice({ id: 1, id_order: 100, number: 1042, date_add: "2026-07-10 10:00:00" }),
    invoice({ id: 2, id_order: 101, number: 1042, date_add: "2026-07-10 10:00:02" }),
  ];
  const collisions = findDuplicateInvoiceNumbers(rows);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].number, 1042);
  assert.deepEqual(new Set(collisions[0].orders), new Set([100, 101]));
  assert.deepEqual(new Set(collisions[0].invoice_ids), new Set([1, 2]));
});

test("same order refetched twice is not a collision", () => {
  const rows = [
    invoice({ id: 1, id_order: 100, number: 1042, date_add: "2026-07-10 10:00:00" }),
    invoice({ id: 1, id_order: 100, number: 1042, date_add: "2026-07-10 10:00:00" }),
  ];
  assert.deepEqual(findDuplicateInvoiceNumbers(rows), []);
});

test("three way collision", () => {
  const rows = [
    invoice({ id: 1, id_order: 100, number: 1042 }),
    invoice({ id: 2, id_order: 101, number: 1042 }),
    invoice({ id: 3, id_order: 102, number: 1042 }),
  ];
  const collisions = findDuplicateInvoiceNumbers(rows);
  assert.equal(collisions.length, 1);
  assert.deepEqual(new Set(collisions[0].orders), new Set([100, 101, 102]));
  assert.equal(collisions[0].invoice_ids.length, 3);
});

test("no invoices no collisions", () => {
  assert.deepEqual(findDuplicateInvoiceNumbers([]), []);
});

test("multiple independent collisions are both reported", () => {
  const rows = [
    invoice({ id: 1, id_order: 100, number: 1042 }),
    invoice({ id: 2, id_order: 101, number: 1042 }),
    invoice({ id: 3, id_order: 200, number: 2001 }),
    invoice({ id: 4, id_order: 201, number: 2001 }),
  ];
  const collisions = findDuplicateInvoiceNumbers(rows);
  assert.equal(collisions.length, 2);
  const numbers = new Set(collisions.map((c) => c.number));
  assert.deepEqual(numbers, new Set([1042, 2001]));
});
