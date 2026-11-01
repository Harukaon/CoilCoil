import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_WAIT_CANCEL_CHANNEL, BACKGROUND_WAIT_STATE_CHANNEL, BACKGROUND_WAKE_FAILURE_CHANNEL,
  type BackgroundWaitState, type BackgroundWaitCancelRequest } from "../extensions/background-wait.ts";
import goalExtension, {
  GOAL_STATE_CHANNEL,
  GOAL_STATE_ENTRY,
  GOAL_TOOL_NAME,
  buildGoalPrompt,
  parseGoalCommand,
  restoredGoalState,
  type GoalState,
} from "../extensions/goal.ts";

interface Emission {
  channel: string;
  value: unknown;
}

function createHarness() {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
  const emissions: Emission[] = [];
  const entries: Array<{ customType: string; data: any }> = [];
  const sentUserMessages: string[] = [];
  const tools: Array<Record<string, any>> = [];
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  let activeTools: string[] = ["read", "bash"];
  const notices: Array<{ text: string; level: string }> = [];

  const pi = {
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: Record<string, any>) {
      tools.push(tool);
      activeTools.push(tool.name);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, options);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    sendUserMessage(content: string) {
      sentUserMessages.push(content);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (next: string[]) => { activeTools = [...next]; },
    events: {
      on(channel: string, listener: (value: unknown) => void) {
        const listeners = eventHandlers.get(channel) ?? new Set();
        listeners.add(listener);
        eventHandlers.set(channel, listeners);
        return () => { listeners.delete(listener); };
      },
      emit(channel: string, value: unknown) {
        emissions.push({ channel, value });
        for (const listener of eventHandlers.get(channel) ?? []) listener(value);
      },
    },
  };
  goalExtension(pi as never);

  const tool = tools.find((candidate) => candidate.name === GOAL_TOOL_NAME);
  assert.ok(tool, "goal_complete tool must be registered");
  const command = commands.get("goal");
  assert.ok(command, "/goal command must be registered");

  let idle = true;
  const ctx = {
    ui: { notify: (text: string, level: string) => { notices.push({ text, level }); } },
    // Restore reads the session branch, so the entries the extension appended
    // are what a reopened session replays.
    sessionManager: {
      getBranch: (): unknown[] => entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })),
    },
    isIdle: () => idle,
    hasPendingMessages: () => false,
  };

  return {
    ctx,
    setIdle: (next: boolean) => { idle = next; },
    notices,
    emissions,
    entries,
    sentUserMessages,
    activeTools: () => activeTools,
    backgroundWait: (waiting: boolean, monitorIds: readonly string[] = waiting ? ["monitor-1"] : []) => {
      pi.events.emit(BACKGROUND_WAIT_STATE_CHANNEL, { waiting, monitorIds } satisfies BackgroundWaitState);
    },
    onBackgroundCancel: (listener: (request: BackgroundWaitCancelRequest) => void) =>
      pi.events.on(BACKGROUND_WAIT_CANCEL_CHANNEL, (value) => listener(value as BackgroundWaitCancelRequest)),
    run: (args: string) => command.handler(args, ctx),
    execute: (params: Record<string, unknown>) => tool.execute("call-1", params, undefined, undefined, ctx) as Promise<{
      isError?: boolean;
      details: { iteration: number; error?: string };
    }>,
    emitEvent: async (name: string, event: unknown) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
    lastState: (): GoalState | undefined => {
      const emission = [...emissions].reverse().find((item) => item.channel === GOAL_STATE_CHANNEL);
      return (emission?.value ?? undefined) as GoalState | undefined;
    },
  };
}

test("/goal arguments separate control words from the goal text", () => {
  assert.deepEqual(parseGoalCommand("  "), { kind: "resume" });
  assert.deepEqual(parseGoalCommand("停止"), { kind: "stop" });
  assert.deepEqual(parseGoalCommand("STOP"), { kind: "stop" });
  assert.deepEqual(parseGoalCommand("status"), { kind: "status" });
  assert.deepEqual(parseGoalCommand(" 完成这个任务 "), { kind: "start", goal: "完成这个任务" });
});

test("a reloaded session restores the goal paused instead of resuming the loop", () => {
  const restored = restoredGoalState([
    { type: "custom", customType: GOAL_STATE_ENTRY, data: { status: "running", goal: "构建功能", iteration: 7 } },
  ]);
  assert.equal(restored?.status, "paused");
  assert.equal(restored?.iteration, 7);
  assert.equal(restoredGoalState([]), undefined);
});

test("the round prompt carries the goal and the round number, never the error text", () => {
  const state: GoalState = {
    version: 1,
    status: "running",
    goal: "让测试全部通过",
    iteration: 3,
    startedAt: 0,
    updatedAt: 0,
    lastError: "provider timeout",
  };
  const prompt = buildGoalPrompt(state, 4);
  assert.match(prompt, /第 4 轮/);
  assert.match(prompt, /让测试全部通过/);
  assert.doesNotMatch(prompt, /provider timeout/);
  assert.match(prompt, new RegExp(GOAL_TOOL_NAME));
});

test("/goal starts a loop without changing tools and sends the first round", async () => {
  const harness = createHarness();
  const original = [...harness.activeTools()];

  await harness.run("完成这个任务");

  assert.equal(harness.activeTools().includes(GOAL_TOOL_NAME), true);
  assert.deepEqual(harness.activeTools(), original);
  assert.equal(harness.sentUserMessages.length, 1);
  assert.match(harness.sentUserMessages[0]!, /第 1 轮/);
  const state = harness.lastState();
  assert.equal(state?.status, "running");
  assert.equal(state?.goal, "完成这个任务");
  assert.equal(state?.iteration, 1);
  assert.equal(harness.entries.at(-1)?.customType, GOAL_STATE_ENTRY);
});

test("a failed turn keeps the loop running and hands the error to the next round", async () => {
  const harness = createHarness();
  await harness.run("完成这个任务");
  await harness.emitEvent("agent_start", { type: "agent_start" });
  await harness.emitEvent("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 rate limited" }],
    willRetry: false,
  });
  await harness.emitEvent("agent_settled", { type: "agent_settled" });

  const state = harness.lastState();
  assert.equal(state?.status, "running");
  // Kept for the UI banner, deliberately absent from what the model is sent.
  assert.equal(state?.lastError, "429 rate limited");
  assert.doesNotMatch(buildGoalPrompt(state!, 2), /429 rate limited/);
});

test("goal_complete ends the loop while preserving the tool prefix", async () => {
  const harness = createHarness();
  await harness.run("完成这个任务");

  const result = await harness.execute({ summary: "全部完成", verification: "npm test 通过" });
  assert.notEqual(result.isError, true);
  assert.equal(result.details.iteration, 1);
  assert.equal(harness.activeTools().includes(GOAL_TOOL_NAME), true);

  // The loop is over, so the session reports no goal at all. Leaving a finished
  // state on the channel is what used to pin "目标已完成" above the composer for
  // the rest of the session, and across reloads.
  assert.equal(harness.lastState(), undefined);
  const ended = harness.entries.filter((entry) => entry.customType === GOAL_STATE_ENTRY).at(-1);
  assert.equal(ended?.data.status, "completed", "the session file still records how the loop ended");

  // A settled turn after completion must not start another round.
  await harness.emitEvent("agent_settled", { type: "agent_settled" });
  assert.equal(harness.sentUserMessages.length, 1);
});

test("goal_complete is refused when no loop is running", async () => {
  const harness = createHarness();
  const result = await harness.execute({ summary: "假装完成了" });
  assert.equal(result.isError, true);
  assert.match(result.details.error ?? "", /没有进行中的目标/);
});

test("/goal stop ends the loop and /goal resumes it", async () => {
  const harness = createHarness();
  await harness.run("完成这个任务");
  await harness.run("stop");
  assert.equal(harness.lastState(), undefined);
  assert.equal(harness.activeTools().includes(GOAL_TOOL_NAME), true);

  await harness.run("");
  assert.equal(harness.lastState()?.status, "running");
  assert.equal(harness.activeTools().includes(GOAL_TOOL_NAME), true);
});

test("reopening a session whose loop already ended reports no goal", async () => {
  const harness = createHarness();
  await harness.run("完成这个任务");
  await harness.run("stop");

  // session_start replays the persisted entry. A stopped loop stays resumable
  // through `/goal`, but it is no longer state the session is in.
  await harness.emitEvent("session_start", { type: "session_start" });
  assert.equal(harness.lastState(), undefined);

  await harness.run("");
  assert.equal(harness.lastState()?.status, "running");
});

test("a settled turn schedules the next round on its own", async () => {
  const harness = createHarness();
  await harness.run("完成这个任务");
  await harness.emitEvent("agent_start", { type: "agent_start" });
  await harness.emitEvent("agent_settled", { type: "agent_settled" });

  const deadline = Date.now() + 8_000;
  while (harness.sentUserMessages.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(harness.sentUserMessages.length, 2);
  assert.match(harness.sentUserMessages[1]!, /第 2 轮/);
  assert.equal(harness.lastState()?.iteration, 2);

  // Leave no live interval behind for the rest of the suite.
  await harness.run("stop");
});

test("a turn that is merely slow is never re-sent", async () => {
  const harness = createHarness();
  await harness.run("完成这个任务");
  await harness.emitEvent("agent_start", { type: "agent_start" });
  // The provider is still thinking: Pi reports the session busy the whole time.
  harness.setIdle(false);

  await new Promise((resolve) => setTimeout(resolve, 3_200));
  assert.equal(harness.sentUserMessages.length, 1);

  await harness.run("stop");
});

test("a waiting background monitor leaves Goal idle without counting or retrying rounds", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const harness = createHarness();
  const tools = harness.activeTools();
  await harness.run("等构建完成后检查产物");
  await harness.emitEvent("agent_start", { type: "agent_start" });
  harness.backgroundWait(true);
  await harness.emitEvent("agent_settled", { type: "agent_settled" });

  t.mock.timers.tick(120_000);
  assert.equal(harness.sentUserMessages.length, 1);
  assert.equal(harness.lastState()?.status, "running");
  assert.equal(harness.lastState()?.iteration, 1);
  assert.deepEqual(harness.activeTools(), tools);
  await harness.run("stop");
});

test("registering a wait cancels an already scheduled round and clearing it does not double-wake", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const harness = createHarness();
  await harness.run("等待远程任务");
  await harness.emitEvent("agent_start", { type: "agent_start" });
  await harness.emitEvent("agent_settled", { type: "agent_settled" });
  harness.backgroundWait(true);
  t.mock.timers.tick(90_000);
  assert.equal(harness.sentUserMessages.length, 1);

  harness.backgroundWait(false);
  t.mock.timers.tick(90_000);
  assert.equal(harness.sentUserMessages.length, 1, "the monitor owns the wake-up, not the Goal ticker");

  await harness.emitEvent("agent_start", { type: "agent_start" });
  await harness.emitEvent("agent_settled", { type: "agent_settled" });
  t.mock.timers.tick(1_500);
  assert.equal(harness.sentUserMessages.length, 2);
  assert.equal(harness.lastState()?.iteration, 2);
  await harness.run("stop");
});

test("a monitor finishing before its registering run settles still waits for the notification run", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const harness = createHarness();
  await harness.run("等待测试结果");
  await harness.emitEvent("agent_start", { type: "agent_start" });
  harness.backgroundWait(true);
  harness.backgroundWait(false);
  await harness.emitEvent("agent_settled", { type: "agent_settled" });
  t.mock.timers.tick(90_000);
  assert.equal(harness.sentUserMessages.length, 1, "the registering run must not schedule a second wake-up");

  await harness.emitEvent("agent_start", { type: "agent_start" });
  await harness.emitEvent("agent_settled", { type: "agent_settled" });
  t.mock.timers.tick(1_500);
  assert.equal(harness.sentUserMessages.length, 2);
  await harness.run("stop");
});

test("a pending monitor also suppresses resending a round whose run has not started", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const harness = createHarness();
  await harness.run("等待已登记的任务");
  harness.backgroundWait(true);
  t.mock.timers.tick(120_000);
  assert.equal(harness.sentUserMessages.length, 1);
  await harness.run("stop");
});

test("a monitor delivered as steering resumes Goal after the continued request settles", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const harness = createHarness();
  await harness.run("等待监控结果后继续验证");
  await harness.emitEvent("agent_start", { type: "agent_start" });
  harness.backgroundWait(true);
  harness.backgroundWait(false);
  // Another tool in the registering batch kept the run alive. Pi consumes the
  // notification as steering and makes a request without emitting agent_start.
  await harness.emitEvent("before_provider_request", { type: "before_provider_request" });
  await harness.emitEvent("agent_settled", { type: "agent_settled" });
  t.mock.timers.tick(1_500);
  assert.equal(harness.sentUserMessages.length, 2);
  await harness.run("stop");
});

test("stopping Goal while it waits prevents a later monitor completion from restarting it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const harness = createHarness();
  await harness.run("等待部署");
  await harness.emitEvent("agent_start", { type: "agent_start" });
  harness.backgroundWait(true);
  await harness.run("stop");
  harness.backgroundWait(false);
  await harness.emitEvent("agent_start", { type: "agent_start" });
  await harness.emitEvent("agent_settled", { type: "agent_settled" });
  t.mock.timers.tick(120_000);
  assert.equal(harness.sentUserMessages.length, 1);
  assert.equal(harness.lastState(), undefined);

  await harness.run("");
  t.mock.timers.tick(1_500);
  assert.equal(harness.sentUserMessages.length, 2, "an explicit resume still works after stopping the wait");
  await harness.run("stop");
});

test("restoring a session clears process-local waits and keeps Goal paused until explicit resume", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const harness = createHarness();
  await harness.run("等待构建");
  harness.backgroundWait(true);
  await harness.emitEvent("session_start", { type: "session_start" });
  t.mock.timers.tick(120_000);
  assert.equal(harness.sentUserMessages.length, 1);
  assert.equal(harness.lastState()?.status, "paused");

  await harness.run("");
  t.mock.timers.tick(1_500);
  assert.equal(harness.sentUserMessages.length, 2, "restoration must not retain monitors owned by a retired process");
  await harness.run("stop");
});

test("shutdown cancels a waiting loop and ignores later background events", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const harness = createHarness();
  await harness.run("等待构建");
  harness.backgroundWait(true);
  await harness.emitEvent("session_shutdown", { type: "session_shutdown" });
  harness.backgroundWait(false);
  t.mock.timers.tick(120_000);
  assert.equal(harness.sentUserMessages.length, 1);
});

test("typed /goal stop cancels a monitor synchronously without waiting for its cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const harness = createHarness();
  await harness.run("等待构建");
  harness.backgroundWait(true);
  let cancelled = false;
  let finish!: () => void;
  const cleanup = new Promise<void>((resolve) => { finish = resolve; });
  harness.onBackgroundCancel((request) => {
    cancelled = true;
    request.cancelled = true;
    request.completion = cleanup;
    harness.backgroundWait(false);
  });
  await harness.run("stop");
  assert.equal(cancelled, true);
  assert.equal(harness.lastState(), undefined);
  t.mock.timers.tick(120_000);
  assert.equal(harness.sentUserMessages.length, 1);
  finish();
});

test("typed /goal stop observes and reports asynchronous monitor cleanup errors", async () => {
  const harness = createHarness();
  await harness.run("等待部署");
  harness.onBackgroundCancel((request) => {
    request.cancelled = true;
    request.completion = Promise.reject(new Error("cleanup rejected"));
  });
  await harness.run("stop");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const failure = harness.emissions.find((event) => event.channel === BACKGROUND_WAKE_FAILURE_CHANNEL);
  assert.match((failure?.value as { error: string }).error, /cleanup rejected/);
  assert.equal(harness.lastState(), undefined);
});
