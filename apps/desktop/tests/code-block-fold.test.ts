import assert from "node:assert/strict";
import test from "node:test";
import { COLLAPSED_CODE_HEIGHT, shouldFoldCodeBlock } from "../src/renderer/src/features/conversation/CollapsibleCodeBlock.tsx";

test("a block that fits is left alone", () => {
  assert.equal(shouldFoldCodeBlock(0), false);
  assert.equal(shouldFoldCodeBlock(COLLAPSED_CODE_HEIGHT), false);
});

test("a block barely past the limit is not worth a fold", () => {
  // Hiding a line or two behind a button costs the reader a click and saves
  // nothing, so the fold only starts once there is real height to reclaim.
  assert.equal(shouldFoldCodeBlock(COLLAPSED_CODE_HEIGHT + 40), false);
});

test("a long block folds", () => {
  assert.equal(shouldFoldCodeBlock(COLLAPSED_CODE_HEIGHT + 200), true);
});
