import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "@coilcoil/runtime-protocol";
import { CoilCoilRuntime } from "../src/index.js";
import { ToolRunIds } from "../src/tool-run-ids.js";

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
  const runtime = new CoilCoilRuntime({
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
    pendingUserPrompts: [],
    promptQueue: [],
    steeringMessages: [],
    promptDrainInProgress: false,
    nextTimelineOrder: 0,
    toolRunIds: new ToolRunIds(),
    responseMetricsHistory: [],
    sessionRevision: 1,
    eventBus: { on: () => undefined } as never,
  };
  return { runtime, events, calls, gates, session };
}

test("messages submitted during a run execute strictly FIFO after each run settles", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-prompt-queue-"));
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
  const root = mkdtempSync(join(tmpdir(), "coilcoil-prompt-queue-failure-"));
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

test("a prompt accepted after its predecessor settled is still sent", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-prompt-queue-late-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const harness = createQueueHarness(root);

  await harness.runtime.prompt("第一条", undefined, "client-1");
  harness.gates[0]!.resolve();
  await settleMicrotasks();

  // The owning run has finished and its `finally` has already been and gone,
  // but `isStreaming` still reads true — the exact window in which the queue
  // used to deadlock, because nothing was left to drain it.
  harness.session.isStreaming = true;
  await harness.runtime.prompt("第二条", undefined, "client-2");
  await settleMicrotasks();
  assert.deepEqual(harness.calls, ["第一条"], "must not start while Pi reports streaming");

  harness.session.isStreaming = false;
  // Nothing else will wake the queue here, so the bounded re-check is the only
  // thing that can start it. Wait past one retry interval.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(harness.calls, ["第一条", "第二条"]);
});

test("a queued prompt can be withdrawn before it starts", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-prompt-queue-cancel-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const harness = createQueueHarness(root);

  await harness.runtime.prompt("第一条", undefined, "client-1");
  await harness.runtime.prompt("第二条", undefined, "client-2");
  await harness.runtime.prompt("第三条", undefined, "client-3");

  assert.deepEqual(await harness.runtime.cancelQueuedPrompt("client-2"), { cancelled: true });
  assert.deepEqual(
    harness.events.filter((event) => event.type === "prompt_queue_updated").at(-1)?.queue.map((item) => item.text),
    ["第三条"],
  );
  // Withdrawing must also retract the optimistic bubble the renderer showed.
  assert.ok(harness.events.some((event) => event.type === "message_rejected" && event.id === "client-2"));

  harness.gates[0]!.resolve();
  await settleMicrotasks();
  assert.deepEqual(harness.calls, ["第一条", "第三条"]);

  assert.deepEqual(await harness.runtime.cancelQueuedPrompt("client-2"), { cancelled: false });
});
