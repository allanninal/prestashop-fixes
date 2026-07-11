import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRestockAlert } from "./detect-restock-alerts.js";

test("flags when zero to positive on active visible product", () => {
  const result = decideRestockAlert(0, 5, true, "both");
  assert.equal(result.action, "flag_restock_alert");
});

test("flags when negative to positive on active visible product", () => {
  const result = decideRestockAlert(-2, 3, true, "both");
  assert.equal(result.action, "flag_restock_alert");
});

test("record only when no prior quantity", () => {
  const result = decideRestockAlert(null, 5, true, "both");
  assert.equal(result.action, "record_only");
  assert.match(result.reason, /no prior quantity/);
});

test("record only when no current row", () => {
  const result = decideRestockAlert(0, null, true, "both");
  assert.equal(result.action, "record_only");
  assert.match(result.reason, /no stock_availables row/);
});

test("record only when quantity stays positive", () => {
  const result = decideRestockAlert(5, 8, true, "both");
  assert.equal(result.action, "record_only");
});

test("record only when quantity drops to zero", () => {
  const result = decideRestockAlert(5, 0, true, "both");
  assert.equal(result.action, "record_only");
});

test("record only when product inactive", () => {
  const result = decideRestockAlert(0, 5, false, "both");
  assert.equal(result.action, "record_only");
});

test("record only when visibility none", () => {
  const result = decideRestockAlert(0, 5, true, "none");
  assert.equal(result.action, "record_only");
});

test("record only when quantity stays at or below zero", () => {
  const result = decideRestockAlert(0, 0, true, "both");
  assert.equal(result.action, "record_only");
});
