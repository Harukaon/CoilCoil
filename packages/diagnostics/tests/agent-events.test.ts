import assert from "node:assert/strict";
import test from "node:test";
import { AgentDiagnosticRecorder } from "../src/agent-events.ts";
import { diagnosticValueSummary } from "../src/metadata.ts";

function recorder() {
  const entries: Array<{ level: string; scope: string; event: string; data?: Record<string, unknown>; context?: unknown }> = [];
  const recorder = new AgentDiagnosticRecorder({ log: (level, scope, event, data, context) => { entries.push({ level, scope, event, data, context }); } },
    () => ({ sessionId: "s2", sessionPath: "/sessions/s2.jsonl", cwd: "/project", provider: "claude-second", role: "main" }));
  return { recorder, entries };
}

test("tool failures and corrected parameters remain correlated across repeated provider call ids without bodies", () => {
  const { recorder: r, entries } = recorder();
  r.record({ type: "agent_start" });
  r.record({ type: "turn_start" });
  r.record({ type: "tool_execution_start", toolCallId: "call_0", toolName: "mcp", args: { action: "call", server: "docs", tool: "get", args: { pageId: "2", text: "PRIVATE_INPUT" } } });
  r.record({ type: "tool_execution_end", toolCallId: "call_0", toolName: "mcp", isError: true, durationMs: 9,
    result: { content: [{ type: "text", text: "pageId: expected number while looking up PRIVATE_INPUT" }] } });
  r.record({ type: "turn_start" });
  r.record({ type: "tool_execution_start", toolCallId: "call_0", toolName: "mcp", args: { action: "call", server: "docs", tool: "get", args: { pageId: 2, text: "PRIVATE_INPUT" } } });
  r.record({ type: "tool_execution_end", toolCallId: "call_0", toolName: "mcp", isError: false,
    result: { content: [{ type: "text", text: "PRIVATE_RESULT".repeat(10_000) }] } });
  const starts = entries.filter((entry) => entry.event === "started" && entry.scope === "tool");
  assert.equal(starts[1].data?.previousFailureSequence, starts[0].data?.sequence);
  assert.deepEqual(starts[1].data?.changedKeys, ["args.pageId"]);
  const ends = entries.filter((entry) => entry.event === "finished");
  assert.deepEqual(ends.map((entry) => entry.level), ["error", "info"]);
  assert.equal(ends[1].data?.textResultEstimatedTokens, "PRIVATE_RESULT".length * 10_000 / 4);
  assert.equal(ends[1].data?.tokenEstimateMethod, "text_chars_div_4");
  const serialized = JSON.stringify(entries);
  assert.ok(!serialized.includes("PRIVATE_INPUT"));
  assert.ok(!serialized.includes("PRIVATE_RESULT"));
  assert.ok(serialized.length < 8_000);
});

test("schema rejection before execution logs announced shape and model usage includes cache/cost", () => {
  const { recorder: r, entries } = recorder();
  r.record({ type: "turn_start" });
  r.record({ type: "message_end", message: { role: "assistant", provider: "claude-second", model: "opus",
    usage: { input: 100, output: 20, cacheRead: 800, cacheWrite: 90, totalTokens: 1010, cost: { total: 0.2 } }, stopReason: "toolUse",
    content: [{ type: "text", text: "PRIVATE_RESPONSE" }, { type: "toolCall", id: "t1", name: "write", arguments: { path: "/project/test.ts", content: "PRIVATE_FILE" } }] } });
  r.record({ type: "tool_execution_end", toolCallId: "t1", toolName: "write", isError: true, result: { content: [{ type: "text", text: "Invalid type for content" }] } });
  const response = entries.find((entry) => entry.event === "response_finished")!.data!;
  assert.equal(response.cacheReadTokens, 800); assert.equal(response.cost, 0.2);
  const tool = entries.find((entry) => entry.event === "finished")!.data!;
  assert.equal(tool.executed, false); assert.ok(tool.parameterShape);
  assert.equal(tool.path, "/project/test.ts");
  assert.ok(!JSON.stringify(entries).includes("PRIVATE_"));
});

test("metadata summary is bounded on deep/cyclic values and never retains string content", () => {
  const value: Record<string, unknown> = { text: "PRIVATE".repeat(20_000), n: 3 };
  value.self = value;
  const summary = diagnosticValueSummary(value);
  assert.equal(summary.bytes, 140_000); assert.equal(summary.bounded, true);
  assert.ok(!JSON.stringify(summary).includes("PRIVATE"));
  assert.notEqual(diagnosticValueSummary({ pageId: 2 }).fingerprint, diagnosticValueSummary({ pageId: "2" }).fingerprint);
});
