import assert from "node:assert/strict";
import test from "node:test";
import { browserCssBoundsToDip } from "../src/main/browser-bounds.ts";

test("browser bounds convert zoomed renderer CSS pixels to native window DIP", () => {
  assert.deepEqual(
    browserCssBoundsToDip(
      { x: 413, y: 157, width: 883, height: 1_041, visible: true },
      4 / 3,
      { width: 1_728, height: 1_598 },
    ),
    { x: 551, y: 209, width: 1_177, height: 1_388, visible: true },
  );
});

test("browser bounds remain unchanged at 100 percent zoom", () => {
  assert.deepEqual(
    browserCssBoundsToDip(
      { x: 900, y: 90, width: 500, height: 700, visible: true },
      1,
      { width: 1_500, height: 900 },
    ),
    { x: 900, y: 90, width: 500, height: 700, visible: true },
  );
});

test("browser native bounds are clipped to the owning content area", () => {
  assert.deepEqual(
    browserCssBoundsToDip(
      { x: 700, y: 400, width: 300, height: 300, visible: true },
      1.5,
      { width: 1_200, height: 800 },
    ),
    { x: 1_050, y: 600, width: 150, height: 200, visible: true },
  );
});
