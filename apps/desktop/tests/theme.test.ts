import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SURFACE_STYLE, SURFACE_STYLES } from "../src/renderer/src/theme.ts";

test("new installations default to the layered surface style", () => {
  assert.equal(DEFAULT_SURFACE_STYLE, "layered");
  assert.deepEqual(SURFACE_STYLES.map((style) => style.id), ["flat", "layered"]);
});
