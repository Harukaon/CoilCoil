import assert from "node:assert/strict";
import test from "node:test";
import { htmlZoomFrameStyle, normalizeHtmlZoom, stepHtmlZoom } from "../src/renderer/src/features/files/htmlZoom.ts";

test("HTML preview zoom follows stable steps and bounds", () => {
  assert.equal(stepHtmlZoom(100, -1), 90);
  assert.equal(stepHtmlZoom(100, 1), 110);
  assert.equal(stepHtmlZoom(50, -1), 50);
  assert.equal(stepHtmlZoom(200, 1), 200);
  assert.equal(normalizeHtmlZoom(Number.NaN), 100);
});

test("HTML preview keeps one viewport while scaling its iframe", () => {
  assert.deepEqual(htmlZoomFrameStyle(50), { width: "200%", height: "200%", transform: "scale(0.5)" });
  assert.deepEqual(htmlZoomFrameStyle(200), { width: "50%", height: "50%", transform: "scale(2)" });
});
