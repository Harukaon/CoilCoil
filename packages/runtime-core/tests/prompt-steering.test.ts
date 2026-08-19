import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "@suocode/runtime-protocol";
import { SuoCodeRuntime } from "../src/index.js";
import { ToolRunIds } from "../src/tool-run-ids.js";

interface RuntimeInternals {
  active?: Record<string, any>;
  handleSessionEvent(event: unknown): void;
}

interface PromptCall {
  text: string;
  streamingBehavior?: string;
}

function createSteerHarness(root: string) {
  const events: RuntimeEvent[] = [];
  const calls: PromptCall[] = [];
  const runtime = new SuoCodeRuntime({
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    onEvent: (event) => events.push(event),
  });
  const internals = runtime as unknown as RuntimeInternals;
  const session: Record<string, any> = {
    isStreaming: false,
    aborted: false,
    abort: async () => { session.aborted = true; },
    messages: [],
    setSessionName: () => undefined,
    prompt: async (text: string, options?: { preflightResult?: (ok: boolean) => void; streamingBehavior?: string }) => {
      calls.push({ text, streamingBehavior: options?.streamingBehavior });
      options?.preflightResult?.(true);
      if (!options?.streamingBehavior) {
        session.isStreaming = true;
        internals.handleSessionEvent({
          type: "message_start",
          message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
        });
        // The run stays open so the test can interject into it.
        return new Promise<void>(() => undefined);
      }
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
    toolRunIds: new ToolRunIds(),
    responseMetricsHistory: [],
    sessionRevision: 1,
    eventBus: { on: () => undefined } as never,
  };
  return { runtime, events, calls, session, active: internals.active };
}

test("a steered message joins the running turn instead of the queue", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-steer-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { runtime, calls, active } = createSteerHarness(root);

  await runtime.prompt("第一条", undefined, "client-1");
  const result = await runtime.steer("补充一句", undefined, "client-2");

  assert.equal(result.steered, true);
  assert.deepEqual(calls.map((call) => call.streamingBehavior), [undefined, "steer"]);
  assert.equal(calls[1]?.text, "补充一句");
  // Steering never touches the FIFO the queue button owns.
  assert.equal(active.promptQueue.length, 0);
});

test("with nothing streaming a steer takes the ordinary path", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-steer-idle-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { runtime, calls } = createSteerHarness(root);

  const result = await runtime.steer("第一条", undefined, "client-1");

  assert.equal(result.steered, false);
  assert.deepEqual(calls.map((call) => call.streamingBehavior), [undefined]);
});

test("promoting a queued prompt hands it to the running turn", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-promote-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { runtime, calls, active } = createSteerHarness(root);

  await runtime.prompt("第一条", undefined, "client-1");
  await runtime.prompt("排队的一条", undefined, "client-2");
  assert.equal(active.promptQueue.length, 1);

  const result = await runtime.promoteQueuedPrompt("client-2");

  assert.deepEqual(result, { promoted: true, steered: true });
  assert.equal(active.promptQueue.length, 0);
  assert.deepEqual(calls.at(-1), { text: "排队的一条", streamingBehavior: "steer" });
});

test("an unknown id promotes nothing", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-promote-missing-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { runtime } = createSteerHarness(root);

  await runtime.prompt("第一条", undefined, "client-1");
  assert.deepEqual(await runtime.promoteQueuedPrompt("client-9"), { promoted: false, steered: false });
});

test("stopping returns at once and drops what was queued behind the turn", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-abort-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { runtime, events, active, session } = createSteerHarness(root);
  let abortSettled = false;
  // A tool that ignores the signal keeps Pi's own abort() pending; the command
  // must not wait for it.
  session.abort = async () => {
    session.aborted = true;
    await new Promise<void>((resolve) => { setTimeout(resolve, 10_000).unref(); });
    abortSettled = true;
  };

  await runtime.prompt("第一条", undefined, "client-1");
  await runtime.prompt("排队一", undefined, "client-2");
  await runtime.prompt("排队二", undefined, "client-3");
  assert.equal(active.promptQueue.length, 2);

  const result = await runtime.abort();

  assert.equal(result.aborted, true);
  assert.equal(result.aborting, true);
  assert.equal(result.cancelledQueue, 2);
  assert.equal(session.aborted, true);
  assert.equal(abortSettled, false, "the command must not wait for the run to settle");
  assert.equal(active.promptQueue.length, 0);
  assert.ok(events.some((event) => event.type === "run_state" && event.aborting === true));
});

test("stopping a session that is no longer streaming republishes the truth", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-abort-idle-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { runtime, events } = createSteerHarness(root);

  const result = await runtime.abort();

  assert.deepEqual(result, { aborted: false, aborting: false, cancelledQueue: 0 });
  const runState = events.filter((event) => event.type === "run_state").at(-1);
  assert.deepEqual(runState, { type: "run_state", running: false, aborting: false });
});

test("in goal mode a message joins the running turn instead of queueing", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-goal-steer-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { runtime, calls, active } = createSteerHarness(root);
  active.goal = { status: "running", goal: "完成这个任务", iteration: 3, startedAt: 0, updatedAt: 0 };

  await runtime.prompt("第一条", undefined, "client-1");
  await runtime.prompt("换个方向", undefined, "client-2");

  assert.deepEqual(calls.map((call) => call.streamingBehavior), [undefined, "steer"]);
  assert.equal(active.promptQueue.length, 0, "goal mode never leaves a message waiting in the FIFO");
});

test("a stopped goal loop gets the ordinary queue back", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "suocode-goal-stopped-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { runtime, calls, active } = createSteerHarness(root);
  active.goal = { status: "stopped", goal: "完成这个任务", iteration: 3, startedAt: 0, updatedAt: 0 };

  await runtime.prompt("第一条", undefined, "client-1");
  await runtime.prompt("排队的一条", undefined, "client-2");

  assert.deepEqual(calls.map((call) => call.streamingBehavior), [undefined]);
  assert.equal(active.promptQueue.length, 1);
});
