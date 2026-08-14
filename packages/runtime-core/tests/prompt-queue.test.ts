import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "@suocode/runtime-protocol";
import { SuoCodeRuntime } from "../src/index.js";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolvePromise = (): void => undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

interface RuntimeInternals {
  active?: Record<string, any>;
  handleSessionEvent(event: unknown): void;
}

async function settleMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function createQueueHarness(root: string, failures = new Set<number>()) {
  const events: RuntimeEvent[] = [];
  const calls: string[] = [];
  const gates: Deferred[] = [];
  const runtime = new SuoCodeRuntime({
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    onEvent: (event) => events.push(event),
  });
  const internals = runtime as unknown as RuntimeInternals;
  let callNumber = 0;
  const session = {
    isStreaming: false,
    messages: [],
    setSessionName: () => undefined,
    prompt: async (text: string, options?: { preflightResult?: (ok: boolean) => void }, _clientMessageId?: string) => {
      const index = callNumber++;
      calls.push(text);
      options?.preflightResult?.(true);
      session.isStreaming = true;
      const active = internals.active!;
      internals.handleSessionEvent({
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
      });
      if (failures.has(index)) {
        session.isStreaming = false;
        throw new Error(`模拟第 ${index + 1} 条失败`);
      }
      const gate = deferred();
      gates.push(gate);
      return gate.promise.finally(() => { session.isStreaming = false; });
    },
  };
  internals.active = {
    cwd: root,
    session: session as unknown as AgentSession,
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
    responseMetricsHistory: [],
    sessionRevision: 1,
    eventBus: { on: () => undefined } as never,
  };
  return { runtime, events, calls, gates, session };
}

test("messages submitted during a run execute strictly FIFO after each run settles", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-prompt-queue-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const harness = createQueueHarness(root);

  await harness.runtime.prompt("第一条", undefined, "client-1");
  await harness.runtime.prompt("第二条", undefined, "client-2");
  await harness.runtime.prompt("第三条", undefined, "client-3");
  assert.deepEqual(harness.calls, ["第一条"]);
  assert.deepEqual(harness.events.filter((event) => event.type === "prompt_queue_updated").map((event) => event.queue.map((item) => item.text)), [["第二条"], ["第二条", "第三条"]]);

  harness.gates[0]!.resolve();
  await settleMicrotasks();
  assert.deepEqual(harness.calls, ["第一条", "第二条"]);
  assert.equal(harness.session.isStreaming, true);

  harness.gates[1]!.resolve();
  await settleMicrotasks();
  assert.deepEqual(harness.calls, ["第一条", "第二条", "第三条"]);
  harness.gates[2]!.resolve();
  await settleMicrotasks();
  assert.equal(harness.session.isStreaming, false);
  assert.equal(harness.events.filter((event) => event.type === "prompt_queue_updated").at(-1)?.type, "prompt_queue_updated");
  assert.deepEqual(harness.events.filter((event) => event.type === "prompt_queue_updated").at(-1)?.queue, []);
});

test("a failed queued prompt is removed and does not block later messages", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-prompt-queue-failure-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const harness = createQueueHarness(root, new Set([1]));

  await harness.runtime.prompt("第一条", undefined, "client-1");
  await harness.runtime.prompt("失败的第二条", undefined, "client-2");
  await harness.runtime.prompt("继续的第三条", undefined, "client-3");
  harness.gates[0]!.resolve();
  await settleMicrotasks();
  await settleMicrotasks();

  assert.deepEqual(harness.calls, ["第一条", "失败的第二条", "继续的第三条"]);
  assert.ok(harness.events.some((event) => event.type === "runtime_error" && event.message.includes("模拟第 2 条失败")));
  assert.deepEqual(harness.events.filter((event) => event.type === "prompt_queue_updated").at(-1)?.queue, []);
  harness.gates[1]!.resolve();
});
