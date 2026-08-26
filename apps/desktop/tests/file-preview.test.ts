import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

test("the HTML preview runs scripts but never on this window's origin", () => {
  // Scripts are what make a page's animations previewable. allow-same-origin is
  // what would make that dangerous: it would hand the framed file access to this
  // window and its storage, so the two must never appear together.
  const source = readFileSync(resolve(import.meta.dirname, "../src/renderer/src/features/files/FilePreviewPane.tsx"), "utf8");
  const sandbox = source.match(/sandbox="([^"]*)"/);

  assert.ok(sandbox, "The HTML preview iframe must declare a sandbox.");
  assert.equal(sandbox[1], "allow-scripts");
});
