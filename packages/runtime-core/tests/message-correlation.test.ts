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
  queueClientMessage(active: Record<string, unknown>, clientMessageId?: string): void;
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
    pendingUserMessageIds: [],
    promptQueue: [],
    promptDrainInProgress: false,
    nextTimelineOrder: 0,
    toolRunIds: new ToolRunIds(),
    responseMetricsHistory: [],
    sessionRevision: 1,
    eventBus: createEventBus(),
  };
  internals.active = active;
  internals.queueClientMessage(active, "client-message-1");

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
