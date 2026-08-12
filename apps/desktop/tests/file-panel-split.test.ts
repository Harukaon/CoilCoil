import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FILE_PREVIEW_SHARE,
  clampFilePreviewShare,
  readStoredFilePreviewShare,
} from "../src/renderer/src/features/files/useFilePanelSplit.ts";

test("file preview split keeps both panes recoverable", () => {
  assert.equal(clampFilePreviewShare(0.01, 800), 0.12);
  assert.equal(clampFilePreviewShare(0.99, 800), 0.88);
  assert.equal(clampFilePreviewShare(0.6, 800), 0.6);
  assert.equal(clampFilePreviewShare(0.9, 160), 0.55);
});

test("file preview split restores a valid preference", () => {
  assert.equal(readStoredFilePreviewShare({ getItem: () => "0.72" }), 0.72);
  assert.equal(readStoredFilePreviewShare({ getItem: () => "invalid" }), DEFAULT_FILE_PREVIEW_SHARE);
  assert.equal(readStoredFilePreviewShare({ getItem: () => "1.4" }), DEFAULT_FILE_PREVIEW_SHARE);
});
