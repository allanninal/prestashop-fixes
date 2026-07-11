import { test } from "node:test";
import assert from "node:assert/strict";
import { findOverusedVouchers } from "./audit-guest-voucher-reuse.js";

const RULE = { id: 42, code: "WELCOME10", quantity_per_user: 1, quantity: 500 };

const order = (over = {}) => ({ id: 1, id_customer: 10, current_state: 2, ...over });
const customer = (id, email) => ({ id, email });
const link = (idOrder, idCartRule = 42) => ({ id_cart_rule: idCartRule, id_order: idOrder });

test("no overage when email used once", () => {
  const orders = [order({ id: 1, id_customer: 10 })];
  const customers = [customer(10, "same@example.com")];
  const result = findOverusedVouchers([RULE], [link(1)], orders, customers);
  assert.deepEqual(result, []);
});

test("flags same email across different guest customers", () => {
  const orders = [
    order({ id: 1, id_customer: 10 }),
    order({ id: 2, id_customer: 11 }),
    order({ id: 3, id_customer: 12 }),
  ];
  const customers = [
    customer(10, "same@example.com"),
    customer(11, "same@example.com"),
    customer(12, "same@example.com"),
  ];
  const links = [link(1), link(2), link(3)];
  const result = findOverusedVouchers([RULE], links, orders, customers);
  assert.equal(result.length, 1);
  assert.equal(result[0].email, "same@example.com");
  assert.equal(result[0].actualUses, 3);
  assert.deepEqual(result[0].idOrders, [1, 2, 3]);
});

test("different emails are not grouped together", () => {
  const orders = [order({ id: 1, id_customer: 10 }), order({ id: 2, id_customer: 11 })];
  const customers = [customer(10, "a@example.com"), customer(11, "b@example.com")];
  const links = [link(1), link(2)];
  const result = findOverusedVouchers([RULE], links, orders, customers);
  assert.deepEqual(result, []);
});

test("excludes cancelled and error orders", () => {
  const orders = [
    order({ id: 1, id_customer: 10, current_state: 2 }),
    order({ id: 2, id_customer: 11, current_state: 8 }), // PS_OS_CANCELED
  ];
  const customers = [customer(10, "same@example.com"), customer(11, "same@example.com")];
  const links = [link(1), link(2)];
  const result = findOverusedVouchers([RULE], links, orders, customers);
  assert.deepEqual(result, []);
});

test("respects higher quantity_per_user", () => {
  const rule = { id: 7, code: "VIP2", quantity_per_user: 2, quantity: 50 };
  const orders = [order({ id: 1, id_customer: 10 }), order({ id: 2, id_customer: 11 })];
  const customers = [customer(10, "same@example.com"), customer(11, "same@example.com")];
  const links = [link(1, 7), link(2, 7)];
  const result = findOverusedVouchers([rule], links, orders, customers);
  assert.deepEqual(result, []);
});

test("flagged list sorted by cart rule then email", () => {
  const orders = [
    order({ id: 1, id_customer: 10 }),
    order({ id: 2, id_customer: 11 }),
    order({ id: 3, id_customer: 12 }),
    order({ id: 4, id_customer: 13 }),
  ];
  const customers = [
    customer(10, "z@example.com"),
    customer(11, "z@example.com"),
    customer(12, "a@example.com"),
    customer(13, "a@example.com"),
  ];
  const links = [link(1), link(2), link(3), link(4)];
  const result = findOverusedVouchers([RULE], links, orders, customers);
  const emails = result.map((entry) => entry.email);
  const sorted = [...emails].sort();
  assert.deepEqual(emails, sorted);
});

test("unknown cart rule id is skipped", () => {
  const orders = [order({ id: 1, id_customer: 10 }), order({ id: 2, id_customer: 11 })];
  const customers = [customer(10, "same@example.com"), customer(11, "same@example.com")];
  const links = [link(1, 999), link(2, 999)]; // 999 not in cartRules list
  const result = findOverusedVouchers([RULE], links, orders, customers);
  assert.deepEqual(result, []);
});

test("order missing customer id is excluded", () => {
  const orders = [order({ id: 1, id_customer: null }), order({ id: 2, id_customer: null })];
  const customers = [];
  const links = [link(1), link(2)];
  const result = findOverusedVouchers([RULE], links, orders, customers);
  assert.deepEqual(result, []);
});
