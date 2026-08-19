import assert from "node:assert/strict";
import test from "node:test";
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
  const emissions: Emission[] = [];
  const entries: Array<{ customType: string; data: any }> = [];
  const sentUserMessages: string[] = [];
  const tools: Array<Record<string, any>> = [];
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  let activeTools: string[] = ["read", "bash", "todo"];
  const notices: Array<{ text: string; level: string }> = [];

  const pi = {
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: Record<string, any>) {
      tools.push(tool);
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
      on: () => () => undefined,
      emit(channel: string, value: unknown) {
        emissions.push({ channel, value });
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
    sessionManager: { getBranch: () => [] as unknown[] },
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

test("/goal starts a loop, exposes the completion tool, and sends the first round", async () => {
  const harness = createHarness();
  assert.equal(harness.activeTools().includes(GOAL_TOOL_NAME), false);

  await harness.run("完成这个任务");

  assert.equal(harness.activeTools().includes(GOAL_TOOL_NAME), true);
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

test("goal_complete ends the loop and withdraws the tool", async () => {
  const harness = createHarness();
  await harness.run("完成这个任务");

  const result = await harness.execute({ summary: "全部完成", verification: "npm test 通过" });
  assert.notEqual(result.isError, true);
  assert.equal(result.details.iteration, 1);
  assert.equal(harness.lastState()?.status, "completed");
  assert.equal(harness.activeTools().includes(GOAL_TOOL_NAME), false);

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
  assert.equal(harness.lastState()?.status, "stopped");
  assert.equal(harness.activeTools().includes(GOAL_TOOL_NAME), false);

  await harness.run("");
  assert.equal(harness.lastState()?.status, "running");
  assert.equal(harness.activeTools().includes(GOAL_TOOL_NAME), true);
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
