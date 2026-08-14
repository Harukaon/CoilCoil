import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFastServiceTier,
  FAST_POLICY_ENTRY,
  isGptModelId,
  restoredFastState,
} from "../extensions/fast.ts";

test("Fast only applies to GPT model ids", () => {
  assert.equal(isGptModelId("gpt-5.6"), true);
  assert.equal(isGptModelId("openai/gpt-5.6"), true);
  assert.equal(isGptModelId("claude-opus-4-6"), false);
});

test("Fast state restores from the latest session policy entry", () => {
  assert.equal(restoredFastState([
    { type: "custom", customType: FAST_POLICY_ENTRY, data: { enabled: true } },
    { type: "custom", customType: FAST_POLICY_ENTRY, data: { enabled: false } },
  ]), false);
  assert.equal(restoredFastState([]), false);
});

test("Fast injects priority without mutating the provider payload", () => {
  const payload = { model: "gpt-5.6", input: "hello" };
  assert.deepEqual(applyFastServiceTier(payload, true), {
    model: "gpt-5.6",
    input: "hello",
    service_tier: "priority",
  });
  assert.deepEqual(payload, { model: "gpt-5.6", input: "hello" });
  assert.equal(applyFastServiceTier({ model: "claude-opus-4-6" }, true), undefined);
  assert.equal(applyFastServiceTier(payload, false), undefined);
});
