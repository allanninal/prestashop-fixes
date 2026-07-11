import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidSlug, slugify } from "./fix-invalid-friendly-url-format.js";

test("full url is invalid", () => {
  assert.equal(isValidSlug("abc.com"), false);
});

test("plain slug is valid", () => {
  assert.equal(isValidSlug("my-product-title"), true);
});

test("accented slug valid when allowed", () => {
  assert.equal(isValidSlug("cafe-noir", true), true);
});

test("underscore and hyphen alone still pass in plain mode", () => {
  assert.equal(isValidSlug("cafe_noir-2"), true);
});

test("space is invalid even in accented mode", () => {
  assert.equal(isValidSlug("cafe noir", true), false);
});

test("empty string is invalid", () => {
  assert.equal(isValidSlug(""), false);
});

test("slash is invalid", () => {
  assert.equal(isValidSlug("path/to/thing"), false);
});

test("scheme-like value is invalid", () => {
  assert.equal(isValidSlug("https://example.com"), false);
});

test("dot is invalid", () => {
  assert.equal(isValidSlug("abc.com"), false);
});

test("colon is invalid", () => {
  assert.equal(isValidSlug("a:b"), false);
});

test("backslash is invalid", () => {
  assert.equal(isValidSlug("a\\b"), false);
});

test("slugify strips accents and punctuation", () => {
  assert.equal(slugify("Café Noir!"), "cafe-noir");
});

test("slugify falls back when empty", () => {
  assert.equal(slugify(""), "untitled");
});

test("slugify lowercases and collapses separators", () => {
  assert.equal(slugify("  Blue   T-Shirt!! "), "blue-t-shirt");
});
