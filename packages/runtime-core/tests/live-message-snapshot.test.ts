import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent, ToolRun } from "@coilcoil/runtime-protocol";
import { CoilCoilRuntime } from "../src/index.js";
import { ToolRunIds } from "../src/tool-run-ids.js";

interface RuntimeInternals {
  active?: Record<string, unknown>;
  handleSessionEvent(event: unknown): void;
  reconstructState(session: AgentSession): { tools: Map<string, ToolRun> };
}

test("a mid-stream snapshot includes the in-progress assistant message instead of dropping it", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-live-message-snapshot-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const manager = SessionManager.inMemory(root);
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "写一部长篇小说" }],
    timestamp: Date.now(),
  } as never);

  const session = {
    sessionManager: manager,
    sessionId: "session-1",
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

  const runtime = new CoilCoilRuntime({
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
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
    pendingUserPrompts: [],
    promptQueue: [],
    steeringMessages: [],
    promptDrainInProgress: false,
    // Deliberately far from reconstructState's own local order counter (which starts at
    // 0 per call) to prove the splice recomputes order rather than trusting this value.
    nextTimelineOrder: 50,
    toolRunIds: new ToolRunIds(),
    responseMetricsHistory: [],
    sessionRevision: 1,
    eventBus: createEventBus(),
  };
  const active = internals.active!;

  internals.handleSessionEvent({
    type: "message_start",
    message: { role: "assistant", content: [{ type: "text", text: "" }], timestamp: Date.now() },
  });
  internals.handleSessionEvent({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "从前" }], timestamp: Date.now() },
    assistantMessageEvent: { type: "text_delta", delta: "从前" },
  });
  internals.handleSessionEvent({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "从前有座山" }], timestamp: Date.now() },
    assistantMessageEvent: { type: "text_delta", delta: "有座山" },
  });

  // A switch to this session mid-stream reads a fresh snapshot before message_end
  // ever fires — this must not silently drop the in-progress assistant message.
  const midStreamSnapshot = await runtime.snapshot();
  const persistedUser = midStreamSnapshot.messages.find((message) => message.role === "user");
  const liveAssistant = midStreamSnapshot.messages.find((message) => message.role === "assistant");

  assert.ok(persistedUser, "persisted user message should still be present");
  assert.ok(liveAssistant, "in-progress assistant message must appear in a mid-stream snapshot");
  assert.equal(liveAssistant?.text, "从前有座山");
  assert.equal(liveAssistant?.status, "running");
  assert.equal(liveAssistant?.id, active.activeAssistantId);
  assert.ok((liveAssistant?.order ?? -1) > (persistedUser?.order ?? -1), "live message must sort after persisted history");

  const finalMessage = { role: "assistant", content: [{ type: "text", text: "从前有座山，山里有座庙。" }], timestamp: Date.now(), stopReason: "stop" };
  manager.appendMessage(finalMessage as never);
  internals.handleSessionEvent({ type: "message_end", message: finalMessage });

  const finishedSnapshot = await runtime.snapshot();
  const finishedAssistantMessages = finishedSnapshot.messages.filter((message) => message.role === "assistant");
  assert.equal(finishedAssistantMessages.length, 1, "the completed message must replace the live buffer, not duplicate it");
  assert.equal(finishedAssistantMessages[0]?.text, "从前有座山，山里有座庙。");
  assert.equal(finishedAssistantMessages[0]?.status, "succeeded");
  assert.equal(active.activeAssistantMessage, undefined);
});

test("assistant tool calls stay visible before a result and survive a live snapshot", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-live-tool-snapshot-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const manager = SessionManager.inMemory(root);
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "启动测试服务" }],
    timestamp: Date.now(),
  } as never);
  const session = {
    sessionManager: manager,
    sessionId: "session-tools",
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
  const events: RuntimeEvent[] = [];
  const runtime = new CoilCoilRuntime({
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
    pendingUserPrompts: [],
    promptQueue: [],
    steeringMessages: [],
    promptDrainInProgress: false,
    nextTimelineOrder: 1,
    toolRunIds: new ToolRunIds(),
    responseMetricsHistory: [],
    sessionRevision: 1,
    eventBus: createEventBus(),
  };

  const assistant: Record<string, unknown> = {
    role: "assistant",
    content: [],
    timestamp: Date.now(),
  };
  internals.handleSessionEvent({ type: "message_start", message: assistant });
  assistant.content = [
    { type: "text", text: "改用本地 HTTP 服务再测。" },
    {
      type: "toolCall",
      id: "bash-server",
      name: "bash",
      arguments: {
        command: "python3 -m http.server 8765 --bind 127.0.0.1",
        cwd: root,
        purpose: "启动本地测试服务",
      },
    },
  ];
  assistant.stopReason = "toolUse";
  internals.handleSessionEvent({ type: "message_end", message: assistant });
  manager.appendMessage(assistant as never);

  const active = internals.active as {
    tools: Map<string, ToolRun>;
    terminals: Map<string, { status: string }>;
  };
  const projected = active.tools.get("bash-server");
  assert.equal(projected?.status, "running");
  assert.equal(projected?.label, "启动本地测试服务");
  assert.equal(active.terminals.get("bash-server")?.status, "running");
  assert.ok(events.some((event) => event.type === "tool_started" && event.tool.id === "bash-server"));

  const projectedOrder = projected?.order;
  internals.handleSessionEvent({
    type: "tool_execution_start",
    toolCallId: "bash-server",
    toolName: "bash",
    args: {
      command: "python3 -m http.server 8765 --bind 127.0.0.1",
      cwd: root,
      timeout: 120,
    },
  });
  assert.equal(active.tools.size, 1, "the durable tool call and live execution must upsert by id");
  assert.equal(active.tools.get("bash-server")?.order, projectedOrder);
  assert.equal(active.tools.get("bash-server")?.args.timeout, 120);

  const snapshot = await runtime.snapshot();
  assert.equal(snapshot.tools.length, 1);
  assert.equal(snapshot.tools[0]?.id, "bash-server");
  assert.equal(snapshot.tools[0]?.status, "running", "a live snapshot must override the incomplete historical projection");

  internals.handleSessionEvent({
    type: "tool_execution_end",
    toolCallId: "bash-server",
    toolName: "bash",
    result: {
      content: [{ type: "text", text: "后台运行中" }],
      details: {
        id: "term-1",
        background_shell_id: "term-1",
        status: "running",
        is_running_in_background: true,
      },
    },
    isError: false,
  });
  assert.equal(active.tools.get("bash-server")?.status, "succeeded", "the handoff tool call itself has completed");
  assert.equal(active.terminals.has("bash-server"), false, "the provisional tool id must be replaced by the stable shell id");
  assert.equal(active.terminals.get("term-1")?.status, "running", "the handed-off process remains live");

  internals.handleSessionEvent({
    type: "entry_appended",
    entry: {
      type: "custom",
      id: "terminal-finished",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "coilcoil-terminal-run",
      data: {
        id: "term-1",
        ownerToolCallId: "bash-server",
        command: "python3 -m http.server 8765 --bind 127.0.0.1",
        cwd: root,
        output: "stopped",
        status: "stopped",
        startedAt: Date.now() - 100,
        endedAt: Date.now(),
      },
    },
  });
  assert.equal(active.terminals.get("term-1")?.status, "stopped", "async completion updates the same terminal row");

  const restoredRuntime = new CoilCoilRuntime({
    agentDir: join(root, "restored-agent"),
    sessionDir: join(root, "restored-sessions"),
  }) as unknown as RuntimeInternals;
  const restored = restoredRuntime.reconstructState({ sessionManager: manager } as AgentSession);
  assert.equal(restored.tools.get("bash-server")?.status, "failed");
  assert.match(restored.tools.get("bash-server")?.output ?? "", /返回执行结果前中断/);
});
