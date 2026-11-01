import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { closeFilePreview, imageMimeType, openFilePreview, previewKind } from "../src/main/file-preview.ts";

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

test("gzip diagnostic archives open as read-only text without changing the compressed file", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-gzip-preview-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "runtime-123-456-abcd.archive-789-abcd.jsonl.gz");
  const content = '{"event":"tool_failed","level":"error"}\n';
  const compressed = gzipSync(content);
  writeFileSync(path, compressed);
  const owner = { id: 77, alive: () => true, send: () => undefined, onGone: () => () => undefined };
  const result = await openFilePreview(owner, { path }, async () => ({ root, path }));
  assert.ok(result.opened);
  assert.equal(result.document.kind, "text");
  assert.equal(result.document.content, content);
  assert.equal(result.document.editable, false);
  assert.deepEqual(readFileSync(path), compressed);
  closeFilePreview(owner.id, result.document.id);
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

test("预览关掉时要把 owner 上的 destroyed 监听摘干净", async () => {
  // 同一个窗口连开几份预览，以前每一份都往 WebContents 上留一个 destroyed 监听，
  // 开到第 11 份 Electron 就报 EventEmitter 泄漏。
  let live = 0;
  const owner = {
    id: 1,
    alive: () => true,
    send: () => undefined,
    onGone: () => {
      live += 1;
      return () => { live -= 1; };
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "coilcoil-preview-leak-"));
  const file = join(dir, "a.txt");
  writeFileSync(file, "hello");
  const resolvePath = async () => ({ root: dir, path: file });

  const opened = [];
  for (let i = 0; i < 12; i++) {
    const result = await openFilePreview(owner, { path: file }, resolvePath);
    assert.ok(result.opened);
    opened.push(result.document.id);
  }
  assert.equal(live, 12, "每份预览各挂一个");
  for (const id of opened) closeFilePreview(owner.id, id);
  assert.equal(live, 0, "关掉之后一个都不该留着");
  rmSync(dir, { recursive: true, force: true });
});
