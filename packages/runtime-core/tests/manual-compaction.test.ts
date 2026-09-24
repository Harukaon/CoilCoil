import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { manualCompactionCommand } from "@coilcoil/runtime-protocol";
import type { RuntimeEvent } from "@coilcoil/runtime-protocol";
import { CoilCoilRuntime } from "../src/index.js";
import { manualCompactionErrorMessage, manualCompactionRefusal } from "../src/manual-compaction.js";
import { ToolRunIds } from "../src/tool-run-ids.js";

interface RuntimeInternals {
  active?: Record<string, any>;
  promptStarting: boolean;
  handleSessionEvent(event: unknown): void;
}

function createCompactionHarness(root: string) {
  const events: RuntimeEvent[] = [];
  const calls: string[] = [];
  let settleCompaction: ((error?: Error) => void) | undefined;
  const session = {
    isStreaming: false,
    messages: [{ role: "user" }, { role: "assistant" }],
    model: { provider: "openai", id: "gpt-5", contextWindow: 200000 },
    thinkingLevel: "medium",
    sessionId: "session-1",
    sessionName: "测试会话",
    sessionManager: {
      getBranch: () => [{ id: "entry-1", type: "message" }],
      getHeader: () => ({ timestamp: new Date().toISOString() }),
      getLeafEntry: () => undefined,
    },
    compact: (instructions?: string) => {
      calls.push(`compact:${instructions ?? ""}`);
      return new Promise<void>((resolve, reject) => {
        settleCompaction = (error?: Error) => { if (error) reject(error); else resolve(); };
      });
    },
    prompt: (text: string) => {
      calls.push(`prompt:${text}`);
      return Promise.resolve();
    },
    abort: () => { calls.push("abort"); return Promise.resolve(); },
    abortCompaction: () => { calls.push("abortCompaction"); },
    clearQueue: () => ({ steering: [] as string[], followUp: [] as string[] }),
    abortBranchSummary: () => { calls.push("abortBranchSummary"); },
  };
  const runtime = new CoilCoilRuntime({
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    onEvent: (event) => events.push(event),
  });
  const internals = runtime as unknown as RuntimeInternals;
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
  return {
    runtime,
    internals,
    events,
    calls,
    session,
    finishCompaction: (error?: Error) => {
      settleCompaction?.(error);
      settleCompaction = undefined;
    },
  };
}

function withRoot(name: string, context: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), name));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("/compact 被认出来，后面跟着的话是给摘要的要求", () => {
  assert.deepEqual(manualCompactionCommand("/compact"), {});
  assert.deepEqual(manualCompactionCommand("  /compact  "), {});
  // 中文输入法敲出来的全角斜杠，和半角是同一条命令。
  assert.deepEqual(manualCompactionCommand("／compact"), {});
  assert.deepEqual(manualCompactionCommand("/COMPACT"), {});
  assert.deepEqual(manualCompactionCommand("/compact 保留接口改动细节"), { instructions: "保留接口改动细节" });
});

test("长得像但不是这条命令的，照常当成一句话发出去", () => {
  assert.equal(manualCompactionCommand("/compactify 一下"), undefined);
  assert.equal(manualCompactionCommand("帮我 /compact"), undefined);
  assert.equal(manualCompactionCommand("/memory"), undefined);
  assert.equal(manualCompactionCommand(""), undefined);
});

test("不能压的时候，说的是人话而不是 Pi 的英文", () => {
  const base = { compacting: false, summarizing: false, busy: false, hasModel: true, messages: 4, alreadyCompacted: false };
  assert.equal(manualCompactionRefusal(base), undefined);
  assert.match(manualCompactionRefusal({ ...base, busy: true }) ?? "", /先停止或等它结束/);
  assert.match(manualCompactionRefusal({ ...base, alreadyCompacted: true }) ?? "", /没有需要压缩的内容/);
  assert.match(manualCompactionRefusal({ ...base, messages: 0 }) ?? "", /还没有可压缩的上下文/);
  assert.match(manualCompactionErrorMessage("Nothing to compact (session too small)"), /对话还太短/);
  assert.match(manualCompactionErrorMessage("Already compacted"), /没有需要压缩的内容/);
  assert.equal(manualCompactionErrorMessage("Compaction cancelled"), "上下文压缩已取消。");
  assert.match(manualCompactionErrorMessage("socket hang up"), /上下文压缩失败：socket hang up/);
});

test("输入框里的 /compact 走手动压缩，不会变成发给模型的一句话", async (context) => {
  const harness = createCompactionHarness(withRoot("coilcoil-manual-compact-", context));

  await harness.runtime.prompt("/compact 保留接口改动细节");

  assert.deepEqual(harness.calls, ["compact:保留接口改动细节"]);
  harness.finishCompaction();
});

test("压缩期间界面是忙的，压完才恢复", async (context) => {
  const harness = createCompactionHarness(withRoot("coilcoil-compact-busy-", context));
  const runStates = (): boolean[] => harness.events
    .filter((event): event is RuntimeEvent & { type: "run_state"; running: boolean } => event.type === "run_state")
    .map((event) => event.running);

  await harness.runtime.compactNow();
  assert.equal(harness.internals.active!.compacting, true);
  // 压缩不是 streaming，没人说忙的话，界面上就是一个什么都没发生的输入框。
  assert.equal(runStates().at(-1), true, "压缩期间会话是忙的");

  harness.finishCompaction();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(harness.internals.active!.compacting, false);
  assert.equal(runStates().at(-1), false, "压完要把忙碌态收回去");
});

test("正在回复时拒绝压缩，不会打断已经写了一半的回答", async (context) => {
  const harness = createCompactionHarness(withRoot("coilcoil-compact-busy-turn-", context));
  harness.session.isStreaming = true;

  await assert.rejects(harness.runtime.compactNow(), /先停止或等它结束/);
  assert.deepEqual(harness.calls, [], "Pi 的手动压缩会先 abort 当前回复，所以根本不能让它开始");
});

test("上次压缩之后没有新对话，就不去留一条「整理失败」的横线", async (context) => {
  const harness = createCompactionHarness(withRoot("coilcoil-compact-twice-", context));
  harness.session.sessionManager.getBranch = () => [{ id: "entry-1", type: "compaction" }];

  await assert.rejects(harness.runtime.compactNow(), /没有需要压缩的内容/);
  assert.deepEqual(harness.calls, []);
});

test("压缩期间发的消息排队等着，压完再发出去", async (context) => {
  const harness = createCompactionHarness(withRoot("coilcoil-compact-queue-", context));

  await harness.runtime.compactNow();
  await harness.runtime.prompt("接着改这个文件");
  assert.equal(harness.internals.active!.promptQueue.length, 1, "排队，而不是和压缩抢同一段历史");
  assert.deepEqual(harness.calls, ["compact:"], "压缩还没结束，这条消息一个字都还没发出去");

  harness.finishCompaction();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(harness.calls, ["compact:", "prompt:接着改这个文件"], "压完自己把队列接上");
});

test("压得太久可以直接停，停的就是这次压缩", async (context) => {
  const harness = createCompactionHarness(withRoot("coilcoil-compact-stop-", context));

  await harness.runtime.compactNow();
  // Pi 宣布压缩开始，运行时才知道此刻正在摘要的是哪一件事。
  harness.internals.handleSessionEvent({ type: "compaction_start", reason: "manual" });

  const result = await harness.runtime.abort();

  assert.equal(result.aborted, true, "压缩中按停止，不能看起来像没按到");
  assert.ok(harness.calls.includes("abortCompaction"), "停的必须是压缩本身");
  harness.finishCompaction(new Error("Compaction cancelled"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(harness.internals.active!.compacting, false);
});

test("压缩失败会说一声，而不是悄悄结束", async (context) => {
  const harness = createCompactionHarness(withRoot("coilcoil-compact-failed-", context));

  await harness.runtime.compactNow();
  harness.finishCompaction(new Error("Compaction failed: upstream 502"));
  await new Promise((resolve) => setTimeout(resolve, 5));

  const notice = harness.events.find((event) => event.type === "runtime_notice" && event.level === "error");
  assert.ok(notice, "失败必须有一条提示");
  assert.match((notice as { message: string }).message, /上下文压缩失败/);
  assert.equal(harness.internals.active!.compacting, false, "失败之后不能把会话卡在「忙」上");
});
