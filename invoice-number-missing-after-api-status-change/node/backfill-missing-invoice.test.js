import { test } from "node:test";
import assert from "node:assert/strict";
import { decideInvoiceRepair } from "./backfill-missing-invoice.js";

const order = (over = {}) => ({ id: 501, reference: "ABCDE12345", valid: true, current_state: 4, ...over });

test("generates invoice when eligible, enabled, and missing", () => {
  const result = decideInvoiceRepair(order(), true, true, []);
  assert.equal(result.action, "generate_invoice");
  assert.equal(result.reason, "eligible_state_missing_invoice");
});

test("none when invoice already exists", () => {
  const result = decideInvoiceRepair(order(), true, true, [{ id: 9, number: 1042 }]);
  assert.equal(result.action, "none");
  assert.equal(result.reason, "invoice_already_exists");
});

test("skips when state not invoice eligible", () => {
  const result = decideInvoiceRepair(order(), false, true, []);
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "current_state_not_invoice_eligible");
});

test("skips when PS_INVOICE disabled", () => {
  const result = decideInvoiceRepair(order(), true, false, []);
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "ps_invoice_disabled");
});

test("flags when order not valid", () => {
  const result = decideInvoiceRepair(order({ valid: false }), true, true, []);
  assert.equal(result.action, "flag_manual_review");
  assert.equal(result.reason, "order_not_valid_yet");
});

test("PS_INVOICE disabled wins over ineligible state", () => {
  const result = decideInvoiceRepair(order(), false, false, []);
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "ps_invoice_disabled");
});

test("empty invoices list is treated as missing", () => {
  const result = decideInvoiceRepair(order(), true, true, []);
  assert.equal(result.action, "generate_invoice");
});

test("none wins over flag when invoice exists on invalid order", () => {
  const result = decideInvoiceRepair(order({ valid: false }), true, true, [{ id: 1 }]);
  assert.equal(result.action, "none");
  assert.equal(result.reason, "invoice_already_exists");
});
