import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCoverState } from "./fix-cover-image.js";

test("no images means no_images status", () => {
  const result = classifyCoverState([]);
  assert.deepEqual(result, { status: "no_images", coverIds: [], chosenCoverId: null });
});

test("ok when exactly one cover", () => {
  const images = [
    { id_image: 1, cover: "1", position: 0 },
    { id_image: 2, cover: "0", position: 1 },
  ];
  const result = classifyCoverState(images);
  assert.deepEqual(result, { status: "ok", coverIds: [1], chosenCoverId: 1 });
});

test("no_cover picks lowest position", () => {
  const images = [
    { id_image: 5, cover: "0", position: 2 },
    { id_image: 3, cover: "0", position: 0 },
    { id_image: 4, cover: "0", position: 1 },
  ];
  const result = classifyCoverState(images);
  assert.equal(result.status, "no_cover");
  assert.deepEqual(result.coverIds, []);
  assert.equal(result.chosenCoverId, 3);
});

test("no_cover breaks position tie by lowest id", () => {
  const images = [
    { id_image: 9, cover: "0", position: 0 },
    { id_image: 2, cover: "0", position: 0 },
  ];
  const result = classifyCoverState(images);
  assert.equal(result.status, "no_cover");
  assert.equal(result.chosenCoverId, 2);
});

test("multi_cover flags all cover ids and chooses lowest position", () => {
  const images = [
    { id_image: 1, cover: "1", position: 3 },
    { id_image: 2, cover: "1", position: 0 },
    { id_image: 3, cover: "0", position: 1 },
  ];
  const result = classifyCoverState(images);
  assert.equal(result.status, "multi_cover");
  assert.deepEqual([...result.coverIds].sort(), [1, 2]);
  assert.equal(result.chosenCoverId, 2);
});

test("multi_cover breaks position tie by lowest id", () => {
  const images = [
    { id_image: 7, cover: "1", position: 0 },
    { id_image: 4, cover: "1", position: 0 },
  ];
  const result = classifyCoverState(images);
  assert.equal(result.status, "multi_cover");
  assert.equal(result.chosenCoverId, 4);
});

test("boolean true is treated as cover", () => {
  const images = [
    { id_image: 1, cover: true, position: 0 },
    { id_image: 2, cover: false, position: 1 },
  ];
  const result = classifyCoverState(images);
  assert.deepEqual(result, { status: "ok", coverIds: [1], chosenCoverId: 1 });
});

test("three covers flags all and chooses lowest position", () => {
  const images = [
    { id_image: 1, cover: "1", position: 5 },
    { id_image: 2, cover: "1", position: 2 },
    { id_image: 3, cover: "1", position: 8 },
  ];
  const result = classifyCoverState(images);
  assert.equal(result.status, "multi_cover");
  assert.deepEqual([...result.coverIds].sort(), [1, 2, 3]);
  assert.equal(result.chosenCoverId, 2);
});
