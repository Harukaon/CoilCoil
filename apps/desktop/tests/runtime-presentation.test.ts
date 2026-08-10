import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeContextItem } from "@suocode/runtime-protocol";
import { contextRanking, tokenNumber, toolDisplayName } from "../src/renderer/src/features/runtime/runtimePresentation.ts";

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

test("context ranking keeps only the largest active items", () => {
  const item = (id: string, estimatedTokens: number, active = true): RuntimeContextItem => ({
    id,
    kind: "tool_result",
    label: id,
    preview: "",
    estimatedTokens,
    active,
  });
  assert.deepEqual(contextRanking([
    item("small", 2),
    item("inactive", 999, false),
    item("large", 80),
    item("zero", 0),
    item("medium", 30),
  ], 2).map((entry) => entry.id), ["large", "medium"]);
});
