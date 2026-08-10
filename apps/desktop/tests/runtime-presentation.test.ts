import assert from "node:assert/strict";
import test from "node:test";
import { tokenNumber, toolDisplayName } from "../src/renderer/src/features/runtime/runtimePresentation.ts";

test("runtime token values use stable K and M units", () => {
  assert.equal(tokenNumber(999), "999");
  assert.equal(tokenNumber(18_200), "18.2K");
  assert.equal(tokenNumber(200_000), "200K");
  assert.equal(tokenNumber(1_250_000), "1.3M");
});

test("runtime tools use localized product labels", () => {
  assert.equal(toolDisplayName("subagent"), "子代理");
  assert.equal(toolDisplayName("mcpScript"), "MCP 脚本");
  assert.equal(toolDisplayName("custom-tool"), "custom-tool");
});
