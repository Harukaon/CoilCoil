import assert from "node:assert/strict";
import test from "node:test";
import {
  clampPanelWidth,
  minimumWindowWidth,
  MINIMUM_LEFT_PANEL_WIDTH,
  MINIMUM_RIGHT_PANEL_WIDTH,
} from "../src/renderer/src/hooks/usePanelLayout.ts";

test("the conversation sidebar stops at 167 pixels while the inspector keeps its compact minimum", () => {
  assert.equal(MINIMUM_LEFT_PANEL_WIDTH, 167);
  assert.equal(MINIMUM_RIGHT_PANEL_WIDTH, 40);
  assert.equal(clampPanelWidth("left", 40, 1_000, 0), 167);
  assert.equal(clampPanelWidth("right", 20, 1_000, 268), 40);
});

test("panel resizing preserves the minimum conversation width", () => {
  assert.equal(clampPanelWidth("left", 900, 1_000, 0), 685);
  assert.equal(clampPanelWidth("right", 900, 1_000, 268), 417);
  assert.equal(minimumWindowWidth(true, false), 482);
  assert.equal(minimumWindowWidth(true, true), 522);
});
