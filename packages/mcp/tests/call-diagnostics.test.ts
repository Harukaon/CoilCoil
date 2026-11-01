import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseMcpCall } from "../src/call-diagnostics.ts";

test("MCP returned failures, thrown failures and success are all recorded without payloads", async () => {
  const entries: unknown[][] = [];
  const log = (...args: unknown[]) => { entries.push(args); };
  const context = { sessionId: "s", toolCallId: "t", cwd: "/project" };
  const args = { page: 3, query: "PRIVATE_QUERY" };
  const success = { content: [{ type: "text", text: "PRIVATE_RESULT" }] };
  assert.equal(await diagnoseMcpCall(log, context, "docs", "search", args, async () => success), success);
  await diagnoseMcpCall(log, context, "docs", "search", args, async () => ({ isError: true, content: [{ type: "text", text: "Invalid page" }] }));
  await diagnoseMcpCall(log, context, "docs", "search", args, async () => ({ isError: true, content: [{ type: "text", text: "" }] }));
  await diagnoseMcpCall(log, context, "docs", "search", args, async () => ({ isError: true, content: [{ type: "text", text: "No result for PRIVATE_QUERY" }] }));
  await assert.rejects(diagnoseMcpCall(log, context, "docs", "search", args, async () => { throw new Error("Transport disconnected"); }), /disconnected/);
  assert.deepEqual(entries.map(([level, event]) => [level, event]), [
    ["info", "mcp_tool_started"], ["info", "mcp_tool_finished"],
    ["info", "mcp_tool_started"], ["error", "mcp_tool_finished"],
    ["info", "mcp_tool_started"], ["error", "mcp_tool_finished"],
    ["info", "mcp_tool_started"], ["error", "mcp_tool_finished"],
    ["info", "mcp_tool_started"], ["error", "mcp_tool_failed"],
  ]);
  assert.ok(!JSON.stringify(entries).includes("PRIVATE_"));
  const first = entries[0][2] as Record<string, unknown>;
  assert.equal(first.sessionId, "s"); assert.equal(first.toolCallId, "t");
  assert.equal((entries[1][2] as Record<string, unknown>).invocationId, first.invocationId);
});
