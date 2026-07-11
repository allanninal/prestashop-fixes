import { test } from "node:test";
import assert from "node:assert/strict";
import { isOrphanedCodelessVoucher } from "./report-orphaned-vouchers.js";

const TODAY = new Date("2026-07-10T00:00:00Z");

test("exhausted codeless rule is orphaned", () => {
  assert.equal(isOrphanedCodelessVoucher("", 0, "2026-12-31", true, TODAY), true);
});

test("expired codeless rule is orphaned", () => {
  assert.equal(isOrphanedCodelessVoucher("", 5, "2026-01-01", true, TODAY), true);
});

test("disabled codeless rule is orphaned", () => {
  assert.equal(isOrphanedCodelessVoucher("", 5, "2026-12-31", false, TODAY), true);
});

test("still valid codeless rule is not orphaned", () => {
  assert.equal(isOrphanedCodelessVoucher("", 5, "2026-12-31", true, TODAY), false);
});

test("rule with a code is never orphaned even if exhausted", () => {
  assert.equal(isOrphanedCodelessVoucher("SUMMER10", 0, "2026-01-01", false, TODAY), false);
});

test("blank date_to with remaining quantity is not orphaned", () => {
  assert.equal(isOrphanedCodelessVoucher("", 3, null, true, TODAY), false);
});

test("whitespace only code counts as codeless", () => {
  assert.equal(isOrphanedCodelessVoucher("   ", 0, "2026-12-31", true, TODAY), true);
});

test("expired but has code is not orphaned", () => {
  assert.equal(isOrphanedCodelessVoucher("VIP5", 0, "2020-01-01", false, TODAY), false);
});

test("quantity exactly zero is exhausted", () => {
  assert.equal(isOrphanedCodelessVoucher("", 0, null, true, TODAY), true);
});

test("date_to equal to today is not expired", () => {
  assert.equal(isOrphanedCodelessVoucher("", 5, "2026-07-10", true, TODAY), false);
});
