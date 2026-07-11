import { test } from "node:test";
import assert from "node:assert/strict";
import { decideWriteStatus } from "./stock-patch-guard.js";

test("applied when post matches attempted", () => {
  assert.equal(decideWriteStatus(10, 25, 25, false, "PATCH"), "applied");
});

test("no_op when attempted equals pre", () => {
  assert.equal(decideWriteStatus(10, 10, 10, false, "PATCH"), "no_op");
});

test("silently_dropped_redirect when redirected and final GET", () => {
  assert.equal(decideWriteStatus(10, 25, 10, true, "GET"), "silently_dropped_redirect");
});

test("silently_dropped_other when not redirected but unchanged", () => {
  assert.equal(decideWriteStatus(10, 25, 10, false, "PATCH"), "silently_dropped_other");
});

test("silently_dropped_other when redirected but final method not GET", () => {
  assert.equal(decideWriteStatus(10, 25, 10, true, "PATCH"), "silently_dropped_other");
});

test("applied takes priority over redirected flag", () => {
  assert.equal(decideWriteStatus(10, 25, 25, true, "GET"), "applied");
});

test("no_op takes priority even if redirected", () => {
  assert.equal(decideWriteStatus(10, 10, 10, true, "GET"), "no_op");
});

test("final method is case insensitive", () => {
  assert.equal(decideWriteStatus(10, 25, 10, true, "get"), "silently_dropped_redirect");
});

test("negative delta still detected as dropped", () => {
  assert.equal(decideWriteStatus(25, 10, 25, true, "GET"), "silently_dropped_redirect");
});
