import assert from "node:assert/strict";
import test from "node:test";
import { isBrowserViewVisible } from "../src/renderer/src/features/browser/browserViewVisibility.ts";

test("native browser is hidden while a DOM overlay is open", () => {
  assert.equal(isBrowserViewVisible(true, true, true), false);
});

test("native browser returns after the overlay closes when the panel is active", () => {
  assert.equal(isBrowserViewVisible(true, false, true), true);
  assert.equal(isBrowserViewVisible(false, false, true), false);
  assert.equal(isBrowserViewVisible(true, false, false), false);
});
