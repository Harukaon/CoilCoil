import assert from "node:assert/strict";
import test from "node:test";
import { imageMimeType, previewKind } from "../src/main/file-preview.ts";

test("file preview recognizes common image formats and their MIME types", () => {
  assert.equal(previewKind("assets/photo.PNG", false), "image");
  assert.equal(previewKind("assets/animation.webp", false), "image");
  assert.equal(previewKind("assets/icon.svg", false), "image");
  assert.equal(imageMimeType("assets/photo.jpg"), "image/jpeg");
  assert.equal(imageMimeType("assets/icon.svg"), "image/svg+xml");
});

test("force-text keeps image source files inspectable as text", () => {
  assert.equal(previewKind("assets/icon.svg", true), "text");
  assert.equal(previewKind("assets/photo.png", true), "text");
});

test("unsupported binary files still use the fallback actions", () => {
  assert.equal(previewKind("archive.zip", false), undefined);
  assert.equal(imageMimeType("archive.zip"), undefined);
});
