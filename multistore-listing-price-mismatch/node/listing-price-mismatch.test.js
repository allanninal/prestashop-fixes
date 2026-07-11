import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePriceMismatch } from "./diagnose-multistore-listing-price.js";

test("no mismatch when prices are equal", () => {
  const result = decidePriceMismatch(19.99, 19.99, 42, 1);
  assert.equal(result.mismatch, false);
  assert.equal(result.diff, 0);
});

test("no mismatch within rounding tolerance", () => {
  const result = decidePriceMismatch(19.995, 19.99, 42, 1, 0.01);
  assert.equal(result.mismatch, false);
});

test("mismatch when prices differ beyond tolerance", () => {
  const result = decidePriceMismatch(24.99, 19.99, 42, 2);
  assert.equal(result.mismatch, true);
  assert.ok(Math.abs(result.diff - 5.0) < 1e-9);
});

test("mismatch direction does not matter", () => {
  const a = decidePriceMismatch(19.99, 24.99, 42, 2);
  const b = decidePriceMismatch(24.99, 19.99, 42, 2);
  assert.equal(a.mismatch, true);
  assert.equal(b.mismatch, true);
  assert.ok(Math.abs(a.diff - b.diff) < 1e-9);
});

test("custom tolerance is respected", () => {
  const result = decidePriceMismatch(19.99, 20.09, 7, 3, 0.2);
  assert.equal(result.mismatch, false);
});

test("result carries ids and prices", () => {
  const result = decidePriceMismatch(10.0, 12.0, 99, 5);
  assert.equal(result.id_product, 99);
  assert.equal(result.id_shop, 5);
  assert.equal(result.listing_price, 10.0);
  assert.equal(result.single_product_price, 12.0);
});
