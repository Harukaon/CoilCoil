import assert from "node:assert/strict";
import test from "node:test";
import { hasConfigurableThinkingLevel } from "../src/renderer/src/features/composer/modelPickerCapabilities.ts";

test("a fallback off value does not create a Thinking submenu", () => {
  assert.equal(hasConfigurableThinkingLevel(undefined), false);
  assert.equal(hasConfigurableThinkingLevel([]), false);
  assert.equal(hasConfigurableThinkingLevel(["off"]), false);
});

test("models with a real thinking capability retain the parameter menu", () => {
  assert.equal(hasConfigurableThinkingLevel(["high"]), true);
  assert.equal(hasConfigurableThinkingLevel(["off", "medium", "high"]), true);
});
