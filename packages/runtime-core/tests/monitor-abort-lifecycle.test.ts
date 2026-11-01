import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createEventBus, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent, SessionSnapshot } from "@coilcoil/runtime-protocol";
import { BACKGROUND_WAIT_CANCEL_CHANNEL, BACKGROUND_WAIT_STATE_CHANNEL, BACKGROUND_WAKE_FAILURE_CHANNEL,
  type BackgroundWaitCancelRequest } from "@coilcoil/workflow/extensions/background-wait.js";
import { CoilCoilRuntime } from "../src/index.js";
import { installBackgroundWaitState } from "../src/runtime-background-wait.js";
import type { ActiveSession } from "../src/runtime-state.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };

function mockRuntime() {
  const eventBus = createEventBus();
  const events: RuntimeEvent[] = [];
  let abortCalls = 0;
  const session = {
    isStreaming: false,
    abort: async () => { abortCalls++; },
    abortCompaction: () => undefined,
    abortBranchSummary: () => undefined,
    clearQueue: () => ({ steering: [], followUp: [] }),
    prompt: async (_text: string) => { active.goal = undefined; },
  };
  const active = { session, eventBus, promptQueue: [], steeringMessages: [], tools: new Map() } as unknown as ActiveSession;
  const runtime = Object.assign(Object.create(CoilCoilRuntime.prototype) as CoilCoilRuntime, {
    active, promptStarting: false, log: { info: () => undefined },
    emitEvent: (event: RuntimeEvent) => { events.push(event); },
    snapshot: async () => ({ running: session.isStreaming, aborting: active.aborting,
      backgroundWait: active.backgroundWait } as SessionSnapshot),
  });
  installBackgroundWaitState(eventBus, { installed: () => active, current: () => active,
    emit: (event) => { events.push(event); } });
  return { runtime, active, session, eventBus, events, abortCalls: () => abortCalls };
}

test("idle monitor cancellation revokes the wake-up synchronously and tracks cleanup without a model run", async () => {
  const h = mockRuntime();
  const cleanup = deferred();
  let subscribed = true;
  h.eventBus.emit(BACKGROUND_WAIT_STATE_CHANNEL, { waiting: true, monitorIds: ["monitor-1"] });
  h.eventBus.on(BACKGROUND_WAIT_CANCEL_CHANNEL, (value) => {
    const request = value as BackgroundWaitCancelRequest;
    subscribed = false;
    request.cancelled = true;
    request.completion = cleanup.promise;
    h.eventBus.emit(BACKGROUND_WAIT_STATE_CHANNEL, { waiting: false, monitorIds: [] });
  });

  const pending = h.runtime.abort();
  assert.equal(subscribed, false, "cancellation must land before abort yields to stopping Goal");
  assert.equal(h.active.backgroundWait?.waiting, false);
  assert.deepEqual(await pending, { aborted: true, aborting: true, cancelledQueue: 0 });
  assert.equal(h.abortCalls(), 0, "an idle model has no run to abort");
  assert.equal((await h.runtime.snapshot()).running, false);
  assert.equal(h.active.aborting, true);
  const completion = h.active.abortInFlight;
  cleanup.resolve();
  await completion;
  assert.equal(h.active.aborting, false);
  assert.equal(h.active.abortInFlight, undefined);
});

test("background cleanup failures use the runtime error channel and release the abort state", async () => {
  const h = mockRuntime();
  const cleanup = deferred();
  h.eventBus.on(BACKGROUND_WAIT_CANCEL_CHANNEL, (value) => {
    Object.assign(value as object, { cancelled: true, completion: cleanup.promise });
  });
  await h.runtime.abort();
  const completion = h.active.abortInFlight;
  cleanup.reject(new Error("watcher cleanup failed"));
  await completion;
  assert.equal(h.active.aborting, false);
  const errors = h.events.filter((event) => event.type === "runtime_error");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.type === "runtime_error" ? errors[0]!.message : "", /watcher cleanup failed/);
});

test("a run abort failure does not hide watcher cleanup still in flight", async () => {
  const h = mockRuntime();
  const cleanup = deferred(), run = deferred();
  h.session.isStreaming = true;
  h.session.abort = () => run.promise;
  h.eventBus.on(BACKGROUND_WAIT_CANCEL_CHANNEL, (value) => {
    Object.assign(value as object, { cancelled: true, completion: cleanup.promise });
  });
  await h.runtime.abort();
  const completion = h.active.abortInFlight;
  run.reject(new Error("agent abort failed"));
  await flush();
  assert.equal(h.active.aborting, true);
  cleanup.resolve();
  await completion;
  assert.equal(h.active.aborting, false);
  assert.ok(h.events.some((event) => event.type === "runtime_error" && /agent abort failed/.test(event.message)));
});

test("stopping Goal cancels its wait, and a later Stop still aborts a live model during watcher cleanup", async () => {
  const h = mockRuntime();
  const cleanup = deferred();
  h.active.goal = { status: "running", goal: "finish", iteration: 1, startedAt: 0, updatedAt: 0 };
  let listening = true;
  h.eventBus.on(BACKGROUND_WAIT_CANCEL_CHANNEL, (value) => {
    Object.assign(value as object, { cancelled: listening, completion: cleanup.promise });
    listening = false;
    h.eventBus.emit(BACKGROUND_WAIT_STATE_CHANNEL, { waiting: false, monitorIds: [] });
  });
  assert.equal((await h.runtime.stopGoal()).stopped, true);
  assert.equal(listening, false);
  assert.ok(h.active.abortInFlight);

  h.session.isStreaming = true;
  await h.runtime.abort();
  assert.equal(h.abortCalls(), 1, "watcher-only cleanup is distinct from having aborted the agent");
  const completion = h.active.abortInFlight;
  cleanup.resolve();
  await completion;
  assert.equal(h.active.aborting, false);
});

test("monitor state and failures project only into their live session", async () => {
  const eventBus = createEventBus();
  const active = {} as ActiveSession;
  let current = active;
  const events: RuntimeEvent[] = [];
  const projection = installBackgroundWaitState(eventBus, { installed: () => active, current: () => current,
    emit: (event) => { events.push(event); } });
  const ids = ["monitor-1"];
  eventBus.emit(BACKGROUND_WAIT_STATE_CHANNEL, { waiting: true, monitorIds: ids });
  ids.push("unrelated");
  assert.deepEqual(projection.getState(), { waiting: true, monitorIds: ["monitor-1"] });
  assert.deepEqual(events, [{ type: "background_wait_updated", backgroundWait: { waiting: true, monitorIds: ["monitor-1"] } }]);
  eventBus.emit(BACKGROUND_WAKE_FAILURE_CHANNEL, { error: "notification rejected" });
  assert.ok(events.some((event) => event.type === "runtime_error" && /notification rejected/.test(event.message)));
  const before = events.length;
  current = {} as ActiveSession;
  eventBus.emit(BACKGROUND_WAIT_STATE_CHANNEL, { waiting: false, monitorIds: [] });
  eventBus.emit(BACKGROUND_WAKE_FAILURE_CHANNEL, { error: "retired notification" });
  await flush();
  assert.equal(events.length, before);
});

test("background waiting updates never publish or overwrite the agent running and aborting state", async () => {
  const eventBus = createEventBus();
  const active = { session: { isStreaming: true }, aborting: true } as ActiveSession;
  const events: RuntimeEvent[] = [];
  installBackgroundWaitState(eventBus, { installed: () => active, current: () => active,
    emit: (event) => { events.push(event); } });
  eventBus.emit(BACKGROUND_WAIT_STATE_CHANNEL, { waiting: true, monitorIds: ["monitor-1"] });
  eventBus.emit(BACKGROUND_WAIT_STATE_CHANNEL, { waiting: false, monitorIds: [] });
  await flush();
  assert.equal(active.aborting, true);
  assert.equal(active.session.isStreaming, true);
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.type === "background_wait_updated"));
});

test("rapid wait start and cancellation publish ordered synchronous updates without a delayed snapshot", async () => {
  const eventBus = createEventBus();
  const active = {} as ActiveSession;
  const events: RuntimeEvent[] = [];
  installBackgroundWaitState(eventBus, { installed: () => active, current: () => active,
    emit: (event) => { events.push(event); } });
  eventBus.emit(BACKGROUND_WAIT_STATE_CHANNEL, { waiting: true, monitorIds: ["monitor-1"] });
  assert.equal(events.length, 1);
  eventBus.emit(BACKGROUND_WAIT_STATE_CHANNEL, { waiting: false, monitorIds: [] });
  assert.equal(events.length, 2);
  active.aborting = true;
  await flush();
  assert.deepEqual(events, [
    { type: "background_wait_updated", backgroundWait: { waiting: true, monitorIds: ["monitor-1"] } },
    { type: "background_wait_updated", backgroundWait: { waiting: false, monitorIds: [] } },
  ]);
  assert.equal(active.aborting, true);
});

async function realRuntime(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "coil-monitor-runtime-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent"), workflowDir = join(root, "workflow");
  for (const path of [cwd, agentDir, workflowDir]) mkdirSync(path);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const releaseFile = join(root, "release-monitor");
  const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";
  const watcher = 'const fs=require("node:fs"),path=require("node:path");const file=process.argv[1];'
    + 'const finish=()=>{if(fs.existsSync(file)){console.log("ready");watch.close();}};'
    + 'const watch=fs.watch(path.dirname(file),finish);finish();';
  const command = [process.execPath, "-e", watcher, releaseFile].map(quote).join(" ");
  writeFileSync(join(workflowDir, "package.json"), JSON.stringify({ pi: { extensions: ["default-tools", "mcp-tools", "goal", "terminal", "runtime-bridge"]
    .map((name) => fileURLToPath(new URL(`../../workflow/extensions/${name}.ts`, import.meta.url))) } }));
  const authPath = join(agentDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "offline-monitor-test" } }));
  const models = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  const events: RuntimeEvent[] = [];
  const runtime = new CoilCoilRuntime({ agentDir, sessionDir: join(root, "sessions"), workflowDir,
    modelRuntime: models, checkpoints: false, onEvent: (event) => { events.push(event); } });
  const internal = runtime as unknown as { active: ActiveSession; mcpManager(): unknown };
  t.mock.method(internal, "mcpManager", () => ({ directTools: async () => [], status: async () => ({ servers: [] }) }));
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    const event = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
    const first = requests === 1;
    return new Response(
      event("message_start", { type: "message_start", message: { id: `msg_monitor_${requests}`, role: "assistant", content: [],
        usage: { input_tokens: 10, output_tokens: 0 } } })
      + event("content_block_start", { type: "content_block_start", index: 0, content_block: first
        ? { type: "tool_use", id: "watch", name: "monitor", input: {} } : { type: "text", text: "" } })
      + event("content_block_delta", { type: "content_block_delta", index: 0, delta: first
        ? { type: "input_json_delta", partial_json: JSON.stringify({ command, description: "wait for readiness" }) }
        : { type: "text_delta", text: "resumed" } })
      + event("content_block_stop", { type: "content_block_stop", index: 0 })
      + event("message_delta", { type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } })
      + event("message_stop", { type: "message_stop" }), { headers: { "content-type": "text/event-stream" } });
  });
  t.after(async () => {
    await runtime.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });
  await runtime.createSession(cwd, { provider: "anthropic", modelId: "claude-sonnet-5-5", thinkingLevel: "off" });
  internal.active.titleAttempted = true;
  const waitUntil = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(predicate(), "runtime reached the expected state");
  };
  return { runtime, internal, events, waitUntil, requests: () => requests,
    release: () => writeFileSync(releaseFile, "ready") };
}

test("real runtime Stop cancels an idle monitor, prevents its later wake-up, and accepts the next user turn", {
  timeout: 20_000,
}, async (t) => {
  const { runtime, internal, events, waitUntil, requests, release } = await realRuntime(t);
  await runtime.prompt("Watch the test command and wait for its result");
  await waitUntil(() => internal.active.backgroundWait?.waiting === true && !internal.active.session.isStreaming);
  const waiting = await runtime.snapshot();
  assert.equal(waiting.running, false);
  assert.equal(waiting.backgroundWait?.waiting, true);
  assert.equal(requests(), 1, "registering a monitor ends the model loop");
  const monitorResult = [...internal.active.session.messages].reverse().find((message) => message.role === "toolResult" && message.toolName === "monitor");
  const pid = (monitorResult as { details?: { pid?: number } } | undefined)?.details?.pid;
  assert.equal(typeof pid, "number");

  const result = await runtime.abort();
  assert.equal(result.aborted, true);
  assert.equal(internal.active.backgroundWait?.waiting, false);
  await internal.active.abortInFlight;
  assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" }, "the owned watcher process must be cleaned up");
  release();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(requests(), 1, "the stopped watcher cannot wake a new model request");
  await runtime.prompt("Continue with a new user request");
  await waitUntil(() => requests() === 2 && !internal.active.session.isStreaming);
  assert.equal((await runtime.snapshot()).running, false);
  assert.equal(requests(), 2);
  assert.equal(events.some((event) => event.type === "runtime_error"), false);
});


test("real monitor output wakes an idle AgentSession exactly once after a silent wait", { timeout: 20_000 }, async (t) => {
  const { runtime, internal, events, waitUntil, requests, release } = await realRuntime(t);
  await runtime.prompt("Watch readiness and resume when it changes");
  await waitUntil(() => internal.active.backgroundWait?.waiting === true && !internal.active.session.isStreaming);
  const waiting = await runtime.snapshot();
  assert.equal(waiting.running, false);
  assert.equal(waiting.backgroundWait?.waiting, true);
  assert.equal(requests(), 1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(requests(), 1, "silence must not poll the provider or spend another model turn");

  release();
  await waitUntil(() => requests() >= 2 && !internal.active.session.isStreaming);
  const resumed = await runtime.snapshot();
  assert.equal(resumed.running, false);
  assert.equal(resumed.backgroundWait?.waiting, false);
  assert.ok(internal.active.session.messages.some((message) => message.role === "assistant"
    && Array.isArray(message.content) && message.content.some((block) => block.type === "text" && block.text === "resumed")));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(requests(), 2, "stdout and process exit must not cause duplicate wake-ups");
  assert.equal(events.some((event) => event.type === "runtime_error"), false);
});

test("typing /goal stop cancels the real idle watcher and prevents a later model wake-up", { timeout: 20_000 }, async (t) => {
  const { runtime, internal, events, waitUntil, requests, release } = await realRuntime(t);
  await runtime.prompt("/goal Wait for readiness and inspect the result");
  await waitUntil(() => internal.active.backgroundWait?.waiting === true && !internal.active.session.isStreaming);
  assert.equal(internal.active.goal?.status, "running");
  assert.equal(requests(), 1);
  await runtime.prompt("/goal stop");
  assert.equal(internal.active.goal, undefined);
  assert.equal(internal.active.backgroundWait?.waiting, false);
  release();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(requests(), 1);
  assert.equal(events.some((event) => event.type === "runtime_error"), false);
});

test("a new user message starts immediately while a real monitor is waiting", { timeout: 20_000 }, async (t) => {
  const { runtime, internal, waitUntil, requests } = await realRuntime(t);
  await runtime.prompt("Watch readiness and wait");
  await waitUntil(() => internal.active.backgroundWait?.waiting === true && !internal.active.session.isStreaming);
  await runtime.prompt("Do independent work now");
  await waitUntil(() => requests() === 2 && !internal.active.session.isStreaming);
  assert.equal(internal.active.backgroundWait?.waiting, false);
  assert.equal((await runtime.snapshot()).running, false);
  assert.equal((await runtime.abort()).aborted, true, "the still-live watcher remains cancellable after independent work");
  await internal.active.abortInFlight;
});
