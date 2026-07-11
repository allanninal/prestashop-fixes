import { test } from "node:test";
import assert from "node:assert/strict";
import { detectRateOverwrite } from "./detect-rate-overwrite.js";

test("flags when two disagreeing shops collapse to one rate", () => {
  const previous = { "1:3": 0.92, "2:3": 0.95 };
  const current = { "1:3": 0.90, "2:3": 0.90 };
  const findings = detectRateOverwrite(previous, current);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].idCurrency, 3);
  assert.deepEqual(findings[0].idShopsCollapsed, [1, 2]);
  assert.equal(findings[0].newRate, 0.90);
});

test("no flag when shops already agreed", () => {
  const previous = { "1:3": 0.90, "2:3": 0.90 };
  const current = { "1:3": 0.90, "2:3": 0.90 };
  assert.deepEqual(detectRateOverwrite(previous, current), []);
});

test("no flag when only one shop changed", () => {
  const previous = { "1:3": 0.92, "2:3": 0.95 };
  const current = { "1:3": 0.90, "2:3": 0.95 };
  assert.deepEqual(detectRateOverwrite(previous, current), []);
});

test("no flag with no previous snapshot", () => {
  const current = { "1:3": 0.90, "2:3": 0.90 };
  assert.deepEqual(detectRateOverwrite({}, current), []);
});

test("identifies likely source shop when unambiguous", () => {
  const previous = { "1:3": 0.92, "2:3": 0.95, "3:3": 0.90 };
  const current = { "1:3": 0.90, "2:3": 0.90, "3:3": 0.90 };
  const findings = detectRateOverwrite(previous, current);
  assert.equal(findings[0].likelySourceShop, 3);
});

test("tolerance absorbs tiny float noise", () => {
  const previous = { "1:3": 0.92, "2:3": 0.95 };
  const current = { "1:3": 0.9000001, "2:3": 0.9000002 };
  const findings = detectRateOverwrite(previous, current, 1e-4);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].newRate, 0.9000001);
});

test("multiple currencies are evaluated independently", () => {
  const previous = { "1:3": 0.92, "2:3": 0.95, "1:4": 1.10, "2:4": 1.10 };
  const current = { "1:3": 0.90, "2:3": 0.90, "1:4": 1.10, "2:4": 1.10 };
  const findings = detectRateOverwrite(previous, current);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].idCurrency, 3);
});

test("no flag when three shops all disagreed and all still disagree", () => {
  const previous = { "1:3": 0.90, "2:3": 0.92, "3:3": 0.95 };
  const current = { "1:3": 0.90, "2:3": 0.92, "3:3": 0.95 };
  assert.deepEqual(detectRateOverwrite(previous, current), []);
});

test("no likely source when no shop matches new rate exactly", () => {
  const previous = { "1:3": 0.92, "2:3": 0.95 };
  const current = { "1:3": 0.90, "2:3": 0.90 };
  const findings = detectRateOverwrite(previous, current);
  assert.equal(findings[0].likelySourceShop, null);
});
