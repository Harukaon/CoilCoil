import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeToolDefinition } from "@suocode/runtime-protocol";
import {
  buildRuntimeTokenBreakdown,
  isMcpTool,
  runtimeToolCategory,
} from "../src/runtime-token-breakdown.js";

test("classifies the MCP proxy and direct MCP tools separately from workflow tools", () => {
  assert.equal(isMcpTool("mcp"), true);
  assert.equal(isMcpTool("browser_open", { path: "/tmp/mcp-adapter.ts" }), true);
  assert.equal(isMcpTool("browser_open", undefined, ["browser"]), true);
  assert.equal(isMcpTool("read", { source: "builtin" }), false);
  assert.equal(runtimeToolCategory({
    name: "browser_open",
    description: "",
    parameters: {},
    sourceInfo: { path: "/tmp/mcp-adapter.ts" },
  }), "mcp");
});

test("breaks down current prompt messages and active tool definitions", () => {
  const tools: RuntimeToolDefinition[] = [
    { name: "read", description: "", source: "builtin", category: "tool", active: true, estimatedTokens: 10 },
    { name: "mcp", description: "", source: "mcp-adapter", category: "mcp", active: true, estimatedTokens: 20 },
    { name: "disabled", description: "", source: "builtin", category: "tool", active: false, estimatedTokens: 999 },
  ];
  const breakdown = buildRuntimeTokenBreakdown([
    { role: "user", content: "12345678" },
    { role: "toolResult", toolName: "read", content: "1234" },
    { role: "toolResult", toolName: "mcp", content: "123456" },
    { role: "assistant", content: [{ type: "text", text: "1234" }] },
  ], 5, tools);

  assert.equal(breakdown.userPrompt, 2);
  assert.equal(breakdown.toolDefinitions, 10);
  assert.equal(breakdown.mcpDefinitions, 20);
  assert.equal(breakdown.toolResults, 1);
  assert.equal(breakdown.mcpResults, 2);
  assert.equal(breakdown.systemPrompt, 5);
  assert.equal(breakdown.history, 1);
  assert.equal(breakdown.total, 41);
});
