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

interface RuntimeInternals {
  active?: Record<string, unknown>;
  handleSessionEvent(event: unknown): void;
}

test("a just-finished response is reflected before Pi persists its assistant message", (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-response-metrics-live-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const events: RuntimeEvent[] = [];
  const session = {
    getSessionStats: () => ({
      contextUsage: undefined,
      tokens: { input: 100, output: 20, cacheRead: 400, cacheWrite: 0, total: 520 },
    }),
  } as unknown as AgentSession;
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
    nextTimelineOrder: 0,
    toolRunIds: new ToolRunIds(),
    responseMetricsHistory: [],
    sessionRevision: 1,
    eventBus: createEventBus(),
  };

  internals.handleSessionEvent({
    type: "entry_appended",
    entry: {
      type: "custom",
      customType: "coilcoil-response-metrics",
      data: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 90,
        cacheWriteTokens: 0,
        totalMs: 1_000,
        turnDurationMs: 1_000,
        timestamp: Date.now(),
      },
    },
  });

  const metrics = events.find((event) => event.type === "metrics_updated");
  assert.deepEqual(metrics?.type === "metrics_updated" ? metrics.tokenUsage : undefined, {
    input: 110,
    output: 25,
    cacheRead: 490,
    cacheWrite: 0,
    total: 625,
  });
});
