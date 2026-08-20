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

test("a window grown to the threshold splits the two columns about evenly", () => {
  // 840 is the width the app grows to when the inspector opens on a narrow
  // window, so that layout is the one a reader actually lands on.
  assert.deepEqual(fit(840), { leftWidth: 268, rightWidth: 257 });
  assert.equal(conversationWidth(840), 315);
  const ratio = conversationWidth(840) / fit(840).rightWidth;
  assert.ok(ratio < 1.3, `the two columns should be close to even, was ${ratio.toFixed(2)}:1`);
});

test("the two columns stay level until the inspector reaches its own width", () => {
  for (const width of [900, 935, 1_000]) {
    const gap = Math.abs(conversationWidth(width) - fit(width).rightWidth);
    if (fit(width).rightWidth < 352) assert.ok(gap <= 2, `columns drifted by ${gap}px at ${width}`);
  }
  // Once the inspector has its preferred width the conversation takes the rest.
  assert.equal(fit(1_100).rightWidth, 352);
  assert.equal(fit(1_600).rightWidth, 352);
  assert.equal(conversationWidth(1_600), 1_600 - 268 - 352);
});

test("the conversation never drops below its floor while a panel can still give", () => {
  for (const width of [560, 620, 700, 840, 935, 1_200]) {
    assert.ok(conversationWidth(width) >= 315, `chat was ${conversationWidth(width)}px at ${width}`);
  }
  // Below that the sidebar is the last one asked.
  assert.equal(fit(620).rightWidth, 40);
  assert.equal(fit(620).leftWidth, 265);
});

test("a closed panel is left at the width it will reopen with", () => {
  const closedRight = fitPanelWidths({ windowWidth: 700, leftOpen: true, rightOpen: false, preferredLeftWidth: 268, preferredRightWidth: 352 });
  assert.equal(closedRight.rightWidth, 352);
  assert.equal(closedRight.leftWidth, 268);
});
