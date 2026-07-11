import { test } from "node:test";
import assert from "node:assert/strict";
import { suffixDuplicateSlugs, namesDiverged } from "./fix-duplicated-product-slug.js";

const product = (over = {}) => ({
  id: 1,
  link_rewrite: "desktop-computer",
  name: "Desktop Computer",
  date_add: "2026-01-01 00:00:00",
  ...over,
});

test("no changes when all slugs unique", () => {
  const rows = [
    product({ id: 1, link_rewrite: "desktop-computer" }),
    product({ id: 2, link_rewrite: "laptop-computer" }),
  ];
  assert.deepEqual(suffixDuplicateSlugs(rows, 1), []);
});

test("duplicate keeps earliest and suffixes the rest", () => {
  const rows = [
    product({ id: 1, link_rewrite: "desktop-computer", date_add: "2026-01-01 00:00:00" }),
    product({ id: 7, link_rewrite: "desktop-computer", date_add: "2026-02-15 00:00:00" }),
  ];
  const changes = suffixDuplicateSlugs(rows, 1);
  assert.deepEqual(changes, [{ id: 7, old_slug: "desktop-computer", new_slug: "desktop-computer-7" }]);
});

test("falls back to id when date_add ties", () => {
  const rows = [
    product({ id: 5, link_rewrite: "desktop-computer", date_add: "2026-01-01 00:00:00" }),
    product({ id: 2, link_rewrite: "desktop-computer", date_add: "2026-01-01 00:00:00" }),
  ];
  const changes = suffixDuplicateSlugs(rows, 1);
  assert.deepEqual(changes, [{ id: 5, old_slug: "desktop-computer", new_slug: "desktop-computer-5" }]);
});

test("appends -dup when suffixed candidate already taken", () => {
  const rows = [
    product({ id: 1, link_rewrite: "desktop-computer", date_add: "2026-01-01 00:00:00" }),
    product({ id: 9, link_rewrite: "desktop-computer", date_add: "2026-02-01 00:00:00" }),
    product({ id: 99, link_rewrite: "desktop-computer-9", date_add: "2026-01-05 00:00:00" }),
  ];
  const changes = suffixDuplicateSlugs(rows, 1);
  assert.ok(changes.some((c) => c.id === 9 && c.new_slug === "desktop-computer-9-dup"));
});

test("three way collision keeps earliest and suffixes the rest", () => {
  const rows = [
    product({ id: 3, link_rewrite: "office-chair", date_add: "2026-03-01 00:00:00" }),
    product({ id: 1, link_rewrite: "office-chair", date_add: "2026-01-01 00:00:00" }),
    product({ id: 2, link_rewrite: "office-chair", date_add: "2026-02-01 00:00:00" }),
  ];
  const changes = suffixDuplicateSlugs(rows, 1);
  assert.deepEqual(changes.map((c) => c.id).sort(), [2, 3]);
});

test("namesDiverged true when unrelated", () => {
  assert.equal(namesDiverged("Desktop Computer", "Garden Hose"), true);
});

test("namesDiverged false when still similar", () => {
  assert.equal(namesDiverged("Desktop Computer", "Desktop Computer V2"), false);
});

test("namesDiverged true when either name missing", () => {
  assert.equal(namesDiverged("", "Desktop Computer"), true);
  assert.equal(namesDiverged("Desktop Computer", ""), true);
});
