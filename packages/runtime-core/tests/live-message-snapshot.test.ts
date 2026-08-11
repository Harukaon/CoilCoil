import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SuoCodeRuntime } from "../src/index.js";

interface RuntimeInternals {
  active?: Record<string, unknown>;
  handleSessionEvent(event: unknown): void;
}

test("a mid-stream snapshot includes the in-progress assistant message instead of dropping it", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-live-message-snapshot-"));
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

  const runtime = new SuoCodeRuntime({
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
    pendingUserMessageIds: [],
    // Deliberately far from reconstructState's own local order counter (which starts at
    // 0 per call) to prove the splice recomputes order rather than trusting this value.
    nextTimelineOrder: 50,
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
