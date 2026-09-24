import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "@coilcoil/runtime-protocol";
import { CoilCoilRuntime } from "../src/index.js";
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
  const runtime = new CoilCoilRuntime({
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    checkpoints: false,
    onEvent: (event) => events.push(event),
  });
  const internals = runtime as unknown as RuntimeInternals;
  const session: Record<string, any> = {
    isStreaming: false,
    aborted: false,
    abort: async () => { session.aborted = true; },
    // Pi holds a steered message in its own queue until the agent loop pulls it
    // in, and hands the untaken ones back from clearQueue().
    steering: [] as string[],
    clearQueue: () => {
      const steering = [...(session.steering as string[])];
      session.steering = [];
      return { steering, followUp: [] as string[] };
    },
    messages: [],
    setSessionName: () => undefined,
    prompt: async (text: string, options?: { preflightResult?: (ok: boolean) => void; streamingBehavior?: string }) => {
      calls.push({ text, streamingBehavior: options?.streamingBehavior });
      options?.preflightResult?.(true);
      if (options?.streamingBehavior === "steer") (session.steering as string[]).push(text);
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
  return { runtime, events, calls, session, active: internals.active };
}

test("a steered message joins the running turn instead of the queue", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-steer-"));
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

test("an accepted steer is announced so the transcript can hold it", async (context) => {
  // Pi takes the message now but only appends it when the running turn ends. In
  // between it is in no queue and no transcript, and without this event the UI
  // has nothing to show for it.
  const root = mkdtempSync(join(tmpdir(), "coilcoil-steer-event-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { runtime, events } = createSteerHarness(root);

  await runtime.prompt("第一条", undefined, "client-1");
  await runtime.steer("补充一句", undefined, "client-2");

  const steering = events.filter((event) => event.type === "message_steering") as { id: string; text: string }[];
  assert.deepEqual(steering.map((event) => [event.id, event.text]), [["client-2", "补充一句"]]);
});

test("with nothing streaming a steer takes the ordinary path", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-steer-idle-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { runtime, calls } = createSteerHarness(root);

  const result = await runtime.steer("第一条", undefined, "client-1");

  assert.equal(result.steered, false);
  assert.deepEqual(calls.map((call) => call.streamingBehavior), [undefined]);
});

test("promoting a queued prompt hands it to the running turn", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-promote-"));
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
  const root = mkdtempSync(join(tmpdir(), "coilcoil-promote-missing-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { runtime } = createSteerHarness(root);

  await runtime.prompt("第一条", undefined, "client-1");
  assert.deepEqual(await runtime.promoteQueuedPrompt("client-9"), { promoted: false, steered: false });
});

test("stopping returns at once and drops what was queued behind the turn", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-abort-"));
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
  const root = mkdtempSync(join(tmpdir(), "coilcoil-abort-idle-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { runtime, events } = createSteerHarness(root);

  const result = await runtime.abort();

  assert.deepEqual(result, { aborted: false, aborting: false, cancelledQueue: 0 });
  const runState = events.filter((event) => event.type === "run_state").at(-1);
  assert.deepEqual(runState, { type: "run_state", running: false, aborting: false });
});

test("回溯会等待停止的底层 promise，避免和旧 run 的清理竞态", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-rewind-after-abort-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { runtime, calls, session, active } = createSteerHarness(root);
  session.messages = [{ role: "user", content: "已有消息" }];
  session.navigateTree = async () => ({ cancelled: false });
  (runtime as any).snapshot = async () => ({ });
  (runtime as any).refreshRuntimeInspectionSources = async () => undefined;
  let release!: () => void;
  active.abortInFlight = new Promise<void>((resolve) => { release = resolve; });

  let settled = false;
  const rewind = runtime.rewindPrompt("entry-1", "修改后的提示词", undefined, "client-rewind").then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false);
  assert.equal(calls.length, 0);

  release();
  await rewind;
  assert.equal(settled, true);
  assert.equal(calls[calls.length - 1]?.text, "修改后的提示词");
});

test("in goal mode a message joins the running turn instead of queueing", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-goal-steer-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { runtime, calls, active } = createSteerHarness(root);
  active.goal = { status: "running", goal: "完成这个任务", iteration: 3, startedAt: 0, updatedAt: 0 };

  await runtime.prompt("第一条", undefined, "client-1");
  await runtime.prompt("换个方向", undefined, "client-2");

  assert.deepEqual(calls.map((call) => call.streamingBehavior), [undefined, "steer"]);
  assert.equal(active.promptQueue.length, 0, "goal mode never leaves a message waiting in the FIFO");
});

test("a stopped goal loop gets the ordinary queue back", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-goal-stopped-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { runtime, calls, active } = createSteerHarness(root);
  active.goal = { status: "stopped", goal: "完成这个任务", iteration: 3, startedAt: 0, updatedAt: 0 };

  await runtime.prompt("第一条", undefined, "client-1");
  await runtime.prompt("排队的一条", undefined, "client-2");

  assert.deepEqual(calls.map((call) => call.streamingBehavior), [undefined]);
  assert.equal(active.promptQueue.length, 1);
});

test("stopping takes back a steered message Pi has not delivered yet", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-steer-abort-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { runtime, events, session, active } = createSteerHarness(root);

  await runtime.prompt("第一条", undefined, "client-1");
  await runtime.steer("补充一句", undefined, "client-2");
  assert.deepEqual(session.steering, ["补充一句"]);

  const result = await runtime.abort();

  // Left in Pi's queue it would have been sent on the next turn.
  assert.deepEqual(session.steering, []);
  assert.equal(result.cancelledQueue, 1);
  // The composer gets its text back rather than losing it.
  const rejected = events.filter((event) => event.type === "message_rejected") as { id: string; text?: string }[];
  assert.deepEqual(rejected.map((event) => event.id), ["client-2"]);
  // The text rides along so the composer can put it back for editing.
  assert.equal(rejected[0]?.text, "补充一句");
  assert.equal(active.pendingUserPrompts.some((prompt: { id: string }) => prompt.id === "client-2"), false);
});
