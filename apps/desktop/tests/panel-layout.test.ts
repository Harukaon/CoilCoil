import assert from "node:assert/strict";
import test from "node:test";
import {
  clampPanelWidth,
  fitPanelWidths,
  minimumWindowWidth,
  MINIMUM_LEFT_PANEL_WIDTH,
  MINIMUM_RIGHT_PANEL_WIDTH,
  PANEL_OPEN_WINDOW_WIDTH,
  panelOpenGrowth,
} from "../src/renderer/src/hooks/usePanelLayout.ts";

const fit = (windowWidth: number) => fitPanelWidths({
  windowWidth,
  leftOpen: true,
  rightOpen: true,
  preferredLeftWidth: 268,
  preferredRightWidth: 352,
});
const conversationWidth = (windowWidth: number): number => {
  const { leftWidth, rightWidth } = fit(windowWidth);
  return windowWidth - leftWidth - rightWidth;
};

test("the sidebar stops at 167 pixels and the inspector at 200 pixels", () => {
  assert.equal(MINIMUM_LEFT_PANEL_WIDTH, 167);
  assert.equal(MINIMUM_RIGHT_PANEL_WIDTH, 200);
  assert.equal(clampPanelWidth("left", 40, 1_000, 0), 167);
  assert.equal(clampPanelWidth("right", 20, 1_000, 268), 200);
});

test("panel resizing preserves the minimum conversation width", () => {
  assert.equal(clampPanelWidth("left", 900, 1_000, 0), 685);
  assert.equal(clampPanelWidth("right", 900, 1_000, 268), 417);
  assert.equal(minimumWindowWidth(true, false), 482);
  assert.equal(minimumWindowWidth(true, true), 682);
});

test("a window wide enough to host the inspector never moves to open it", () => {
  assert.equal(PANEL_OPEN_WINDOW_WIDTH, 840);
  for (const width of [840, 900, 1_200, 1_600]) assert.equal(panelOpenGrowth(width), 0, `width ${width}`);
});

test("a window too narrow for the inspector grows exactly up to the threshold", () => {
  assert.equal(panelOpenGrowth(839), 1);
  assert.equal(panelOpenGrowth(800), 40);
  assert.equal(panelOpenGrowth(700), 140);
  // The window reaches the threshold and stops; the panel's own width never
  // enters into it, which is what used to push the window out to the screen edge.
  for (const width of [640, 700, 800]) assert.equal(width + panelOpenGrowth(width), PANEL_OPEN_WINDOW_WIDTH);
});

test("the inspector keeps the width the user dragged it to on a wide window", () => {
  // A window with room to spare must not re-split the columns: the inspector
  // stays at its preferred width and the conversation takes the rest.
  assert.equal(fit(1_000).rightWidth, 352);
  assert.equal(fit(1_100).rightWidth, 352);
  assert.equal(fit(1_600).rightWidth, 352);
  assert.equal(conversationWidth(1_600), 1_600 - 268 - 352);
});

test("the inspector only narrows to leave the conversation its 315px floor", () => {
  // Below the width that fits both panels plus the floor, the inspector gives
  // up its preferred width first, but never below its 200px minimum.
  assert.equal(fit(900).rightWidth, 317);
  assert.equal(conversationWidth(900), 315);
  assert.equal(fit(840).rightWidth, 257);
  assert.equal(conversationWidth(840), 315);
});

test("the inspector never drops below 200px while open", () => {
  // On a window too narrow for both panels plus the floor, the sidebar gives
  // first and the conversation gives last; the inspector holds at 200px.
  assert.equal(fit(700).rightWidth, 200);
  assert.equal(fit(700).leftWidth, 185);
  assert.equal(fit(620).rightWidth, 200);
  assert.equal(fit(620).leftWidth, 167);
  assert.equal(fit(560).rightWidth, 200);
  assert.equal(fit(560).leftWidth, 167);
});

test("a closed panel is left at the width it will reopen with", () => {
  const closedRight = fitPanelWidths({ windowWidth: 700, leftOpen: true, rightOpen: false, preferredLeftWidth: 268, preferredRightWidth: 352 });
  assert.equal(closedRight.rightWidth, 352);
  assert.equal(closedRight.leftWidth, 268);
});
