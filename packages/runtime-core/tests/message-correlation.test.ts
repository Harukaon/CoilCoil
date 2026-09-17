import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "@coilcoil/runtime-protocol";
import { CoilCoilRuntime } from "../src/index.js";
import { ToolRunIds } from "../src/tool-run-ids.js";

interface MessageRuntimeInternals {
  active?: Record<string, unknown>;
  queueClientMessage(active: Record<string, unknown>, clientMessageId: string | undefined, text: string): void;
  handleSessionEvent(event: unknown): void;
}

test("one client message id survives Pi user start and finish events", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-message-correlation-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const events: RuntimeEvent[] = [];
  const runtime = new CoilCoilRuntime({
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    onEvent: (event) => events.push(event),
  });
  const internals = runtime as unknown as MessageRuntimeInternals;
  const active: Record<string, unknown> = {
    cwd: root,
    session: {} as AgentSession,
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
    nextTimelineOrder: 0,
    toolRunIds: new ToolRunIds(),
    responseMetricsHistory: [],
    sessionRevision: 1,
    eventBus: createEventBus(),
  };
  internals.active = active;
  internals.queueClientMessage(active, "client-message-1", "你好");

  internals.handleSessionEvent({
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "你好" }], timestamp: 1 },
  });
  const finishedMessage = { role: "user", content: [{ type: "text", text: "你好" }], timestamp: 1 };
  internals.handleSessionEvent({
    type: "message_end",
    // Pi is allowed to provide a different object instance at the end.
    message: finishedMessage,
  });
  const persistedMessage = { role: "user", content: [{ type: "text", text: "你好" }], timestamp: 1 };
  internals.handleSessionEvent({
    type: "entry_appended",
    entry: { type: "message", id: "entry-1", parentId: null, timestamp: new Date(1).toISOString(), message: persistedMessage },
  });

  const started = events.find((event) => event.type === "message_started");
  const finished = events.find((event) => event.type === "message_finished");
  assert.equal(started?.type === "message_started" ? started.message.id : undefined, "client-message-1");
  assert.equal(finished?.type === "message_finished" ? finished.message.id : undefined, "client-message-1");
  assert.equal(started?.type === "message_started" ? started.revision : undefined, 1);
  assert.equal(finished?.type === "message_finished" ? finished.revision : undefined, 2);
  assert.equal((active.messageIds as WeakMap<object, string>).get(persistedMessage), "client-message-1");

  await new Promise((resolve) => setImmediate(resolve));
});

test("goal 轮次自己发的用户消息不会偷走排队消息的 client id", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-goal-correlation-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const events: RuntimeEvent[] = [];
  const runtime = new CoilCoilRuntime({
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    onEvent: (event) => events.push(event),
  });
  const internals = runtime as unknown as MessageRuntimeInternals;
  const promptQueue = [{ id: "client-queued", text: "跑一下测试", queuedAt: 1 }];
  const active: Record<string, unknown> = {
    cwd: root,
    session: {} as AgentSession,
    unsubscribe: () => undefined,
    tools: new Map(),
    subagents: new Map(),
    terminals: new Map(),
    plan: [],
    project: { cwd: root, files: [], changes: [], terminals: [], plan: [], refreshedAt: 0 },
    messageIds: new WeakMap(),
    messageRevision: 0,
    pendingUserPrompts: [],
    promptQueue,
    promptDrainInProgress: false,
    nextTimelineOrder: 0,
    toolRunIds: new ToolRunIds(),
    responseMetricsHistory: [],
    sessionRevision: 1,
    eventBus: createEventBus(),
  };
  internals.active = active;
  internals.queueClientMessage(active, "client-queued", "跑一下测试");

  // The `/goal` loop feeds itself a round through sendUserMessage. It is a real
  // Pi user message, but no client is waiting for it.
  internals.handleSessionEvent({
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "【目标模式 第 2 轮】继续推进" }], timestamp: 1 },
  });
  const goalRound = events.find((event) => event.type === "message_started");
  assert.notEqual(goalRound?.type === "message_started" ? goalRound.message.id : undefined, "client-queued");
  assert.deepEqual(active.pendingUserPrompts, [{ id: "client-queued", text: "跑一下测试" }]);
  // The user's own message is still queued, waiting to be sent.
  assert.deepEqual(promptQueue.map((item) => item.id), ["client-queued"]);

  events.length = 0;
  internals.handleSessionEvent({
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "跑一下测试" }], timestamp: 2 },
  });
  const own = events.find((event) => event.type === "message_started");
  assert.equal(own?.type === "message_started" ? own.message.id : undefined, "client-queued");
  assert.deepEqual(active.pendingUserPrompts, []);
  assert.deepEqual(promptQueue, []);

  await new Promise((resolve) => setImmediate(resolve));
});
