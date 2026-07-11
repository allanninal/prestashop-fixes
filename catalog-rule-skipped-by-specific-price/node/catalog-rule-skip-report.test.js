import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySkippedProduct } from "./catalog-rule-skip-report.js";

const NOW = "2026-07-10 12:00:00";

const row = (id_product, id_specific_price_rule, from = null, to = null) => ({
  id_product,
  id_specific_price_rule,
  from,
  to,
});

test("not targeted is not skipped", () => {
  const result = classifySkippedProduct({ id_product: 99 }, new Set([1, 2, 3]), [], NOW);
  assert.deepEqual(result, { skipped: false, reason: null });
});

test("manual override with no dates blocks the rule", () => {
  const rows = [row(1, 0)];
  const result = classifySkippedProduct({ id_product: 1 }, new Set([1]), rows, NOW);
  assert.deepEqual(result, { skipped: true, reason: "manual_specific_price_override_active" });
});

test("manual override within the date window blocks the rule", () => {
  const rows = [row(1, 0, "2026-01-01 00:00:00", "2026-12-31 23:59:59")];
  const result = classifySkippedProduct({ id_product: 1 }, new Set([1]), rows, NOW);
  assert.deepEqual(result, { skipped: true, reason: "manual_specific_price_override_active" });
});

test("manual override outside the date window does not block", () => {
  const rows = [row(1, 0, "2020-01-01 00:00:00", "2020-12-31 23:59:59")];
  const result = classifySkippedProduct({ id_product: 1 }, new Set([1]), rows, NOW);
  assert.equal(result.skipped, false);
});

test("manual override starting in the future does not block", () => {
  const rows = [row(1, 0, "2027-01-01 00:00:00", null)];
  const result = classifySkippedProduct({ id_product: 1 }, new Set([1]), rows, NOW);
  assert.equal(result.skipped, false);
});

test("rule applied when only the rule row exists", () => {
  const rows = [row(1, 42)];
  const result = classifySkippedProduct({ id_product: 1 }, new Set([1]), rows, NOW, 42);
  assert.deepEqual(result, { skipped: false, reason: "rule_applied" });
});

test("no override found when there are no rows at all", () => {
  const result = classifySkippedProduct({ id_product: 1 }, new Set([1]), [], NOW);
  assert.deepEqual(result, { skipped: false, reason: "no_override_found" });
});

test("manual row wins even when the rule row also exists", () => {
  const rows = [row(1, 42), row(1, 0)];
  const result = classifySkippedProduct({ id_product: 1 }, new Set([1]), rows, NOW, 42);
  assert.deepEqual(result, { skipped: true, reason: "manual_specific_price_override_active" });
});

test("only checks rows for the given product", () => {
  const rows = [row(2, 0)];
  const result = classifySkippedProduct({ id_product: 1 }, new Set([1, 2]), rows, NOW);
  assert.deepEqual(result, { skipped: false, reason: "no_override_found" });
});

test("no idRule given and only a rule row is no_override_found", () => {
  const rows = [row(1, 42)];
  const result = classifySkippedProduct({ id_product: 1 }, new Set([1]), rows, NOW);
  assert.deepEqual(result, { skipped: false, reason: "no_override_found" });
});
