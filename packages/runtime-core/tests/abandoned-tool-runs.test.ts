import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent, SubagentActivity, TerminalRun, ToolRun } from "@suocode/runtime-protocol";
import { SuoCodeRuntime } from "../src/index.js";
import { ToolRunIds } from "../src/tool-run-ids.js";

interface RuntimeInternals {
  active?: Record<string, unknown>;
  handleSessionEvent(event: unknown): void;
}

interface ActiveForTest {
  tools: Map<string, ToolRun>;
  terminals: Map<string, TerminalRun>;
  subagents: Map<string, SubagentActivity>;
  toolRunIds: ToolRunIds;
}

function startRuntime(root: string, events: RuntimeEvent[]): { internals: RuntimeInternals; active: ActiveForTest; manager: SessionManager; } {
  const manager = SessionManager.inMemory(root);
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "把 Caddy 的活动配置整份打出来" }],
    timestamp: Date.now(),
  } as never);
  const session = {
    sessionManager: manager,
    sessionId: "session-abandoned",
    sessionFile: "",
    sessionName: "",
    messages: [],
    model: undefined,
    isStreaming: true,
    systemPrompt: "",
    getSessionStats: () => ({ contextUsage: undefined, tokens: {} }),
    getActiveToolNames: () => [],
    getAllTools: () => [],
  } as unknown as AgentSession;

  const runtime = new SuoCodeRuntime({
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    onEvent: (event) => events.push(event),
  });
  const internals = runtime as unknown as RuntimeInternals;
  internals.active = {
    cwd: root,
    session,
    unsubscribe: () => undefined,
    tools: new Map(),
    subagents: new Map(),
    terminals: new Map(),
    plan: [],
    project: { cwd: root, files: [], changes: [], terminals: [], plan: [], refreshedAt: 0 },
    messageIds: new WeakMap(),
    messageRevision: 0,
    pendingUserMessageIds: [],
    promptQueue: [],
    promptDrainInProgress: false,
    nextTimelineOrder: 1,
    toolRunIds: new ToolRunIds(),
    responseMetricsHistory: [],
    sessionRevision: 1,
    eventBus: createEventBus(),
  };
  return { internals, active: internals.active as unknown as ActiveForTest, manager };
}

test("a tool call from a dropped stream is closed instead of spinning forever", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-abandoned-tool-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const events: RuntimeEvent[] = [];
  const { internals, active, manager } = startRuntime(root, events);

  // Exactly what `openai-responses` persisted when a long session lost its
  // stream mid-call: the arguments are truncated, the response carries
  // stopReason "error", and Pi retries without ever executing this call.
  const dropped: Record<string, unknown> = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "**Verifying full Caddy config**" },
      {
        type: "toolCall",
        id: "call_knQfNF7rtw7vtqCZqzhYu8UI",
        name: "terminal",
        arguments: { action: "send", id: "term-7", input: "printf '\\n=== APPLY FULL ACTIVE CONFIG PATCH ===\\n'; curl -fsS http://" },
      },
    ],
    timestamp: Date.now(),
    stopReason: "error",
    errorMessage: "OpenAI Responses stream ended before a terminal response event",
  };
  internals.handleSessionEvent({ type: "message_start", message: dropped });
  internals.handleSessionEvent({ type: "message_end", message: dropped });
  manager.appendMessage(dropped as never);

  const abandoned = active.tools.get("call_knQfNF7rtw7vtqCZqzhYu8UI");
  assert.ok(abandoned, "the announced call must still appear in the timeline");
  assert.equal(abandoned?.status, "failed", "a call the agent never executed must not stay running");
  assert.ok(abandoned?.output, "the closed card must say why it has no result");
  assert.ok(abandoned?.endedAt, "a closed card needs an end time");
  assert.ok(
    events.some((event) => event.type === "tool_finished" && event.tool.id === "call_knQfNF7rtw7vtqCZqzhYu8UI"),
    "the renderer only stops the spinner when it is told the run finished",
  );

  // Pi's retry re-issues the same work under a fresh id; that run is unaffected.
  const retried: Record<string, unknown> = {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "call_g3n3KfAMqBx2Gzop5GRDupAZ",
      name: "terminal",
      arguments: { action: "send", id: "term-7", input: "printf '\\n=== APPLY FULL ACTIVE CONFIG PATCH ===\\n'; curl -fsS http://127.0.0.1:2019/config/" },
    }],
    timestamp: Date.now(),
    stopReason: "toolUse",
  };
  internals.handleSessionEvent({ type: "message_end", message: retried });
  assert.equal(active.tools.get("call_g3n3KfAMqBx2Gzop5GRDupAZ")?.status, "running");

  internals.handleSessionEvent({
    type: "tool_execution_end",
    toolCallId: "call_g3n3KfAMqBx2Gzop5GRDupAZ",
    toolName: "terminal",
    result: { content: [{ type: "text", text: "{\"id\":\"term-7\"}" }] },
    isError: false,
  });
  assert.equal(active.tools.get("call_g3n3KfAMqBx2Gzop5GRDupAZ")?.status, "succeeded");
  assert.equal(active.tools.get("call_knQfNF7rtw7vtqCZqzhYu8UI")?.status, "failed", "closing the retry must not reopen the dropped call");
});

test("settling closes a tool, its terminal and its subagent that never reported back", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-settled-sweep-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const events: RuntimeEvent[] = [];
  const { internals, active } = startRuntime(root, events);

  // Execution really started here, so the message itself looks healthy; the run
  // is torn down before any result arrives (an abort, a crashed provider call).
  internals.handleSessionEvent({
    type: "tool_execution_start",
    toolCallId: "call_0",
    toolName: "bash",
    args: { command: "sleep 600", cwd: root },
  });
  internals.handleSessionEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "subagent",
    args: { agent: "explore", task: "读一遍 runtime 事件流" },
  });
  assert.equal(active.tools.get("call_0")?.status, "running");
  assert.equal(active.terminals.get("call_0")?.status, "running");
  assert.equal(active.subagents.get("call_1:0")?.status, "running");

  internals.handleSessionEvent({ type: "agent_settled" });

  assert.equal(active.tools.get("call_0")?.status, "failed", "a settled agent has no tool still running");
  assert.equal(active.terminals.get("call_0")?.status, "failed", "the terminal card must close with its tool");
  assert.equal(active.subagents.get("call_1:0")?.status, "failed", "the subagent placeholder must close with its tool");

  const settledIndex = events.findIndex((event) => event.type === "run_state" && event.running === false);
  const finishedIndex = events.findIndex((event) => event.type === "tool_finished" && event.tool.id === "call_0");
  assert.ok(finishedIndex >= 0, "the sweep must announce the closed run");
  assert.ok(
    settledIndex < 0 || finishedIndex < settledIndex,
    "cards must close before the composer reopens, so no frame shows a free composer over a spinning tool",
  );

  // A provider that restarts its ids every turn must get a fresh card, not the closed one.
  internals.handleSessionEvent({
    type: "tool_execution_start",
    toolCallId: "call_0",
    toolName: "bash",
    args: { command: "echo second turn", cwd: root },
  });
  assert.equal(active.tools.get("call_0")?.status, "failed", "the closed card stays closed");
  assert.equal(active.tools.get("call_0#2")?.status, "running", "the reused provider id opens a new run");
});
