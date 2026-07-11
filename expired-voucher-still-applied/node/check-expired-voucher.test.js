import { test } from "node:test";
import assert from "node:assert/strict";
import { isVoucherExpiredForRecord } from "./check-expired-voucher.js";

const DATE_FROM = 1751328000; // 2025-07-01T00:00:00Z
const DATE_TO = 1751932800;   // 2025-07-08T00:00:00Z

test("valid within window is not flagged", () => {
  assert.equal(isVoucherExpiredForRecord(DATE_FROM + 3600, DATE_FROM, DATE_TO, true), false);
});

test("exactly at date_to is not flagged", () => {
  assert.equal(isVoucherExpiredForRecord(DATE_TO, DATE_FROM, DATE_TO, true), false);
});

test("one second past date_to is flagged", () => {
  assert.equal(isVoucherExpiredForRecord(DATE_TO + 1, DATE_FROM, DATE_TO, true), true);
});

test("before date_from is flagged", () => {
  assert.equal(isVoucherExpiredForRecord(DATE_FROM - 1, DATE_FROM, DATE_TO, true), true);
});

test("inactive rule still referenced is flagged", () => {
  assert.equal(isVoucherExpiredForRecord(DATE_FROM + 3600, DATE_FROM, DATE_TO, false), true);
});

test("inactive and expired is still just flagged true", () => {
  assert.equal(isVoucherExpiredForRecord(DATE_TO + 10, DATE_FROM, DATE_TO, false), true);
});

test("exactly at date_from is not flagged", () => {
  assert.equal(isVoucherExpiredForRecord(DATE_FROM, DATE_FROM, DATE_TO, true), false);
});
