import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type AgentSession,
  createEventBus,
  type EventBusController,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent, SubagentActivity } from "@coilcoil/runtime-protocol";
import { CoilCoilRuntime } from "../src/index.js";

const SUBAGENT_RPC_REQUEST_CHANNEL = "coilcoil:subagents:rpc:v1:request";

interface ReconstructedState {
  subagents: Map<string, SubagentActivity>;
}

interface RuntimeInternals {
  reconstructState(session: AgentSession): ReconstructedState;
  canReloadActiveSession(active: {
    session: { isStreaming: boolean };
    subagents: Map<string, SubagentActivity>;
  }): boolean;
  mergeSubagentActivities(activities: SubagentActivity[]): void;
  active?: {
    eventBus: EventBusController;
    subagents: Map<string, SubagentActivity>;
  };
}

function createRuntime(root: string, onEvent?: (event: RuntimeEvent) => void): CoilCoilRuntime {
  return new CoilCoilRuntime({
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    onEvent,
  });
}

function activity(overrides: Partial<SubagentActivity> = {}): SubagentActivity {
  return {
    id: "sa-test",
    runId: "sa-test",
    index: 0,
    agent: "worker",
    task: "完成任务",
    status: "running",
    background: true,
    controlReady: true,
    toolCount: 0,
    tokens: 0,
    durationMs: 0,
    updatedAt: Date.now(),
    ...overrides,
  };
}

test("historical live subagents restore as stopped and only advertise a usable session", (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-runtime-subagents-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const childSession = join(root, "child.jsonl");
  writeFileSync(childSession, `${JSON.stringify({
    type: "session",
    version: 3,
    id: "child-session",
    timestamp: new Date(0).toISOString(),
    cwd: root,
  })}\n`, "utf8");

  const manager = SessionManager.inMemory(root);
  manager.appendMessage({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "tool-running",
      name: "subagent",
      arguments: { task: "后台任务", background: true },
    }],
    timestamp: Date.now(),
  } as never);
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "tool-running",
    toolName: "subagent",
    content: [{ type: "text", text: "已在后台派发" }],
    details: {
      runId: "sa-running",
      agent: "worker",
      task: "后台任务",
      status: "running",
      background: true,
      sessionFile: childSession,
    },
    isError: false,
    timestamp: Date.now(),
  } as never);
  manager.appendCustomEntry("subagent-run", activity({
    id: "sa-pending",
    runId: "sa-pending",
    status: "pending",
    sessionFile: join(root, "missing-child.jsonl"),
  }));

  const runtime = createRuntime(root);
  const reconstructed = (runtime as unknown as RuntimeInternals).reconstructState({
    sessionManager: manager,
  } as AgentSession);

  const running = reconstructed.subagents.get("sa-running");
  assert.equal(running?.status, "stopped");
  assert.equal(running?.controlReady, false);
  assert.equal(running?.resumable, true);

  const pending = reconstructed.subagents.get("sa-pending");
  assert.equal(pending?.status, "stopped");
  assert.equal(pending?.controlReady, false);
  assert.equal(pending?.resumable, undefined);
});

test("status queries remain ordinary tools and never create fake child runs", (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-runtime-subagent-status-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = SessionManager.inMemory(root);
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "tool-status", name: "subagent", arguments: { action: "status" } }],
    timestamp: Date.now(),
  } as never);
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "tool-status",
    toolName: "subagent",
    content: [{ type: "text", text: "当前没有子 Agent。" }],
    details: { error: "no-runs" },
    isError: false,
    timestamp: Date.now(),
  } as never);

  const runtime = createRuntime(root);
  const reconstructed = (runtime as unknown as RuntimeInternals).reconstructState({ sessionManager: manager } as AgentSession);
  assert.equal(reconstructed.subagents.size, 0);
});

test("terminal child updates clear stale current tool labels", (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-runtime-subagent-current-tool-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = createRuntime(root) as unknown as RuntimeInternals;
  const subagents = new Map<string, SubagentActivity>([["sa-live", activity({
    id: "sa-live",
    runId: "sa-live",
    currentTool: "bash",
    currentPath: "/tmp/task",
  })]]);
  runtime.active = { eventBus: createEventBus(), subagents };

  runtime.mergeSubagentActivities([activity({
    id: "sa-live",
    runId: "sa-live",
    status: "completed",
    controlReady: false,
  })]);

  assert.equal(subagents.get("sa-live")?.currentTool, undefined);
  assert.equal(subagents.get("sa-live")?.currentPath, undefined);
});

test("stopSubagent preserves a terminal activity returned by the RPC bridge", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-runtime-stop-subagent-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const events: RuntimeEvent[] = [];
  const runtime = createRuntime(root, (event) => events.push(event));
  const eventBus = createEventBus();
  const subagents = new Map<string, SubagentActivity>([["sa-done", activity({
    id: "sa-done",
    runId: "sa-done",
  })]]);
  (runtime as unknown as RuntimeInternals).active = { eventBus, subagents };

  eventBus.on(SUBAGENT_RPC_REQUEST_CHANNEL, (raw) => {
    const requestId = (raw as { requestId?: string }).requestId;
    assert.ok(requestId);
    eventBus.emit(`coilcoil:subagents:rpc:v1:reply:${requestId}`, {
      version: 1,
      requestId,
      success: true,
      data: {
        activity: activity({
          id: "sa-done",
          runId: "sa-done",
          status: "completed",
          controlReady: false,
          resumable: true,
          finalOutput: "已经完成",
        }),
      },
    });
  });

  assert.deepEqual(await runtime.stopSubagent("sa-done", true), { stopped: true });
  assert.equal(subagents.get("sa-done")?.status, "completed");
  assert.equal(subagents.get("sa-done")?.controlReady, undefined);
  assert.equal(subagents.get("sa-done")?.finalOutput, "已经完成");
  assert.ok(events.some((event) => event.type === "subagents_updated"));
});

test("resource reload waits for both the parent Agent and live background subagents", (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-runtime-reload-subagent-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = createRuntime(root) as unknown as RuntimeInternals;
  const subagents = new Map<string, SubagentActivity>();
  const active = { session: { isStreaming: false }, subagents };

  assert.equal(runtime.canReloadActiveSession(active), true);
  subagents.set("sa-live", activity());
  assert.equal(runtime.canReloadActiveSession(active), false, "reload would tear down the live child extension");
  subagents.set("sa-live", activity({ status: "completed", controlReady: false }));
  assert.equal(runtime.canReloadActiveSession(active), true);
  active.session.isStreaming = true;
  assert.equal(runtime.canReloadActiveSession(active), false);
});
