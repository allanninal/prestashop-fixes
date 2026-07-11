import { test } from "node:test";
import assert from "node:assert/strict";
import { isOrderStuck } from "./order-stuck-on-stale-status.js";

const TERMINAL = new Set([5, 6, 7, 8]); // Delivered, Canceled, Refunded, Payment error
const NOW = "2026-07-10T00:00:00Z";

test("flags order stuck when state matches history and stale", () => {
  assert.equal(isOrderStuck(2, 2, "2026-06-20T00:00:00Z", NOW, TERMINAL, 5), true);
});

test("not stuck when state is terminal", () => {
  assert.equal(isOrderStuck(6, 6, "2026-06-20T00:00:00Z", NOW, TERMINAL, 5), false);
});

test("not stuck when recent", () => {
  assert.equal(isOrderStuck(2, 2, "2026-07-08T00:00:00Z", NOW, TERMINAL, 5), false);
});

test("not stuck when history disagrees with current_state (desync, not a stall)", () => {
  assert.equal(isOrderStuck(2, 3, "2026-06-20T00:00:00Z", NOW, TERMINAL, 5), false);
});

test("exactly at threshold is not flagged", () => {
  assert.equal(isOrderStuck(2, 2, "2026-07-05T00:00:00Z", NOW, TERMINAL, 5), false);
});

test("one day past threshold is flagged", () => {
  assert.equal(isOrderStuck(2, 2, "2026-07-04T00:00:00Z", NOW, TERMINAL, 5), true);
});

test("custom threshold is respected", () => {
  assert.equal(isOrderStuck(2, 2, "2026-07-08T00:00:00Z", NOW, TERMINAL, 1), true);
});

test("terminal state short-circuits even when stale and matching", () => {
  assert.equal(isOrderStuck(7, 7, "2026-01-01T00:00:00Z", NOW, TERMINAL, 5), false);
});
