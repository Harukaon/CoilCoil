import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { CoilCoilRuntime } from "../src/index.js";
import {
  normalizeSummarizationModelConfiguration,
  parseModelReference,
  readSummarizationModelConfiguration,
  writeSummarizationModelConfiguration,
} from "../src/summarization-model.js";
import { ToolRunIds } from "../src/tool-run-ids.js";

interface RuntimeInternals {
  active?: Record<string, any>;
  ready(): Promise<unknown>;
  publishRuntimeInspection(active: unknown): void;
  applySummarizationModel(active?: unknown): Promise<void>;
  summarizationModelState(): { model: string; unavailable?: boolean };
}

const CHEAP_MODEL = { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini", contextWindow: 200000, maxTokens: 16000 };

function withRoot(name: string, context: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), name));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function createHarness(root: string) {
  const agentDir = join(root, "agent");
  const runtime = new CoilCoilRuntime({
    agentDir,
    sessionDir: join(root, "sessions"),
    onEvent: () => undefined,
  });
  const internals = runtime as unknown as RuntimeInternals;
  const session = {
    isStreaming: false,
    messages: [],
    model: { provider: "anthropic", id: "claude-opus", contextWindow: 200000 },
    summarizationModel: undefined as unknown,
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
  // 只关心「选中了哪个模型」，模型表本身不是这条测试要验的东西。
  internals.ready = async () => ({
    getModel: (provider: string, id: string) =>
      provider === CHEAP_MODEL.provider && id === CHEAP_MODEL.id ? { ...CHEAP_MODEL } : undefined,
  });
  internals.publishRuntimeInspection = () => undefined;
  return { runtime, internals, session, agentDir };
}

test("总结模型的写法：第一个斜杠分家，后面的斜杠属于模型名", () => {
  assert.deepEqual(parseModelReference("openai/gpt-5-mini"), { provider: "openai", id: "gpt-5-mini" });
  // 网关上的模型名自带斜杠，按全部斜杠切会切出一个谁也找不到的模型。
  assert.deepEqual(parseModelReference("openrouter/anthropic/claude-sonnet-4"), {
    provider: "openrouter",
    id: "anthropic/claude-sonnet-4",
  });
  assert.equal(parseModelReference("gpt-5-mini"), undefined);
  assert.equal(parseModelReference("/gpt-5-mini"), undefined);
  assert.equal(parseModelReference("openai/"), undefined);
  assert.equal(parseModelReference("  "), undefined);
});

test("配置文件坏了就当没配，总结继续跑在会话模型上", (context) => {
  const root = withRoot("coilcoil-summary-config-", context);
  const agentDir = join(root, "agent");
  assert.deepEqual(readSummarizationModelConfiguration(agentDir), { model: "" }, "没配过就是空");

  writeSummarizationModelConfiguration(agentDir, { model: "  openai/gpt-5-mini  " });
  assert.deepEqual(readSummarizationModelConfiguration(agentDir), { model: "openai/gpt-5-mini" }, "两头空格不该进配置");
  assert.match(readFileSync(join(agentDir, "summarization-model.json"), "utf8"), /gpt-5-mini/);

  assert.deepEqual(normalizeSummarizationModelConfiguration("坏掉的内容"), { model: "" });
  assert.deepEqual(normalizeSummarizationModelConfiguration({ model: 42 }), { model: "" });
  assert.throws(() => writeSummarizationModelConfiguration(agentDir, { model: 1 } as never), /配置无效/);
});

test("配了总结模型，压缩就跑在它上面，对话模型一动不动", async (context) => {
  const harness = createHarness(withRoot("coilcoil-summary-apply-", context));

  await harness.runtime.saveSummarizationModelConfiguration({ model: "openai/gpt-5-mini" });

  assert.equal((harness.session.summarizationModel as { id: string }).id, "gpt-5-mini");
  assert.equal(harness.session.model.id, "claude-opus", "换的是总结，不是对话");
  assert.deepEqual(harness.internals.summarizationModelState(), { model: "openai/gpt-5-mini", unavailable: false });
});

test("配的模型没了就回退到会话模型，并且说出来——压缩停摆比换个模型贵得多", async (context) => {
  const harness = createHarness(withRoot("coilcoil-summary-missing-", context));

  const saved = await harness.runtime.saveSummarizationModelConfiguration({ model: "deleted/model" });

  assert.equal(saved.unavailable, true, "面板要看得到它不可用");
  assert.equal(harness.session.summarizationModel, undefined, "回退：Pi 会照常用会话模型总结");
  assert.equal(harness.internals.active!.summarizationModelUnavailable, true);
});

test("vendor/pi 那条薄补丁还在——它没了的话总结模型会静静地失效", async () => {
  // 总结跑在哪个模型上，最终是 Pi 说了算。升级 Pi 时这段补丁要是没带上，面板上的配置会看起来
  // 一切正常，账单却还是按主模型算——没人会发现。所以这里盯住它的存在。
  const { AgentSession } = await import("@earendil-works/pi-coding-agent");
  const descriptor = Object.getOwnPropertyDescriptor(AgentSession.prototype, "effectiveSummarizationModel");
  assert.ok(descriptor?.get, "vendor/pi 的 summarizationModel 补丁不见了，详见 docs/pi-upstream.md");
});

test("清空配置就回到跟随会话模型", async (context) => {
  const harness = createHarness(withRoot("coilcoil-summary-clear-", context));
  await harness.runtime.saveSummarizationModelConfiguration({ model: "openai/gpt-5-mini" });

  const cleared = await harness.runtime.saveSummarizationModelConfiguration({ model: "" });

  assert.deepEqual(cleared, { model: "" });
  assert.equal(harness.session.summarizationModel, undefined);
  assert.equal(harness.internals.active!.summarizationModelUnavailable, false);
});
