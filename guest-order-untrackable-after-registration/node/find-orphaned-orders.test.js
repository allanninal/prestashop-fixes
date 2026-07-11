import { test } from "node:test";
import assert from "node:assert/strict";
import { findOrphanedGuestOrders, normalizeEmail } from "./find-orphaned-orders.js";

const guest = (over = {}) => ({ id: 101, email: "jane@example.com", is_guest: "1", ...over });
const real = (over = {}) => ({ id: 205, email: "jane@example.com", is_guest: "0", ...over });
const order = (over = {}) => ({ id: 900, id_customer: 101, reference: "ABCDE", total_paid: "49.90", ...over });

test("finds orphaned order when email matches both groups", () => {
  const plan = findOrphanedGuestOrders([guest()], [real()], [order()]);
  assert.deepEqual(plan, [{
    id_order: 900,
    current_id_customer: 101,
    target_id_customer: 205,
    email: "jane@example.com",
  }]);
});

test("no plan when email only a guest", () => {
  const plan = findOrphanedGuestOrders([guest()], [], [order()]);
  assert.deepEqual(plan, []);
});

test("no plan when order belongs to a different customer", () => {
  const plan = findOrphanedGuestOrders([guest()], [real()], [order({ id_customer: 999 })]);
  assert.deepEqual(plan, []);
});

test("ignores orders already on the real account", () => {
  const orders = [order({ id: 900, id_customer: 101 }), order({ id: 901, id_customer: 205 })];
  const plan = findOrphanedGuestOrders([guest()], [real()], orders);
  assert.deepEqual(plan.map((p) => p.id_order), [900]);
});

test("multiple orphaned orders for the same guest", () => {
  const orders = [order({ id: 900 }), order({ id: 901 })];
  const plan = findOrphanedGuestOrders([guest()], [real()], orders);
  assert.deepEqual(plan.map((p) => p.id_order), [900, 901]);
});

test("email matching is case and space insensitive", () => {
  const g = guest({ email: "  Jane@Example.COM " });
  const plan = findOrphanedGuestOrders([g], [real()], [order()]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].email, "jane@example.com");
});

test("unrelated email pairs are ignored", () => {
  const otherGuest = guest({ id: 111, email: "bob@example.com" });
  const plan = findOrphanedGuestOrders([otherGuest], [real()], [order({ id_customer: 111 })]);
  assert.deepEqual(plan, []);
});

test("normalizeEmail lowers and trims", () => {
  assert.equal(normalizeEmail("  Jane@Example.COM "), "jane@example.com");
});

test("normalizeEmail handles missing input", () => {
  assert.equal(normalizeEmail(undefined), "");
});
