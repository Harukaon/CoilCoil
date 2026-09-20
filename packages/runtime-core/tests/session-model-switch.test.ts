import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { PendingSessionModel, RuntimeConfiguration, RuntimeEvent, SessionSnapshot, ThinkingLevel } from "@coilcoil/runtime-protocol";
import { CoilCoilRuntime } from "../src/index.js";

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

interface ModelSessionDouble {
  isStreaming: boolean;
  model?: Model<any>;
  thinkingLevel: ThinkingLevel;
  setModel(model: Model<any>): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  settingsManager: { flush(): Promise<void> };
}

interface RuntimeInternals {
  active?: { session: ModelSessionDouble; pendingModel?: PendingSessionModel };
  snapshot(): Promise<SessionSnapshot>;
  getConfiguration(): Promise<RuntimeConfiguration>;
  applyPendingSessionModel(active: { session: ModelSessionDouble; pendingModel?: PendingSessionModel }): Promise<void>;
}

function model(provider: string, id: string): Model<any> {
  return {
    provider,
    id,
    name: id,
    api: "openai-responses",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  } as Model<any>;
}

function snapshot(session: ModelSessionDouble): SessionSnapshot {
  return {
    session: {
      id: "session-model-switch",
      path: "/tmp/session-model-switch.jsonl",
      cwd: "/tmp",
      title: "模型切换",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      messageCount: 0,
    },
    agentMode: "standard",
    messages: [],
    promptQueue: [],
    steering: [],
    tools: [],
    subagents: [],
    project: { cwd: "/tmp", files: [], changes: [], terminals: [], plan: [], refreshedAt: 0 },
    model: session.model ? {
      provider: session.model.provider,
      id: session.model.id,
      name: session.model.name,
      reasoning: Boolean(session.model.reasoning),
    } : undefined,
    thinkingLevel: session.thinkingLevel,
    fast: false,
    responseMetricsHistory: [],
    tokenUsage: EMPTY_USAGE,
    runtimeInspection: {
      sessionRevision: 1,
      summaryEvents: [],
      systemPromptOverride: false,
      estimates: {},
      tools: [],
      skills: [],
      capabilities: {
        editSystemPrompt: true,
        removeOriginalSessionItems: false,
        removeOriginalSessionItemsReason: "测试",
      },
    },
    running: session.isStreaming,
  };
}

test("an idle session commits its model before publishing the new snapshot", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-session-model-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = model("pierce", "gpt-5.6-sol");
  const next = model("xai", "grok-4.5");
  const calls: string[] = [];
  const session: ModelSessionDouble = {
    isStreaming: false,
    model: previous,
    thinkingLevel: "high",
    async setModel(selected) {
      calls.push(`model:${selected.provider}/${selected.id}`);
      this.model = selected;
    },
    setThinkingLevel(level) {
      calls.push(`thinking:${level}`);
      this.thinkingLevel = level;
    },
    settingsManager: {
      async flush() { calls.push("flush"); },
    },
  };
  const events: RuntimeEvent[] = [];
  const modelRuntime = {
    getModel: (provider: string, id: string) => provider === next.provider && id === next.id ? next : undefined,
    checkAuth: async () => true,
  } as unknown as ModelRuntime;
  const runtime = new CoilCoilRuntime({
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    modelRuntime,
    onEvent: (event) => events.push(event),
  });
  const internals = runtime as unknown as RuntimeInternals;
  internals.active = { session };
  internals.snapshot = async () => snapshot(session);
  internals.getConfiguration = async () => ({
    provider: session.model?.provider,
    modelId: session.model?.id,
    thinkingLevel: session.thinkingLevel,
    configuredProviders: ["pierce", "xai"],
    models: [],
    migratedLegacyCredentials: false,
  });

  const configuration = await runtime.setSessionModel({
    provider: next.provider,
    modelId: next.id,
    thinkingLevel: "off",
  });

  assert.deepEqual(calls, ["model:xai/grok-4.5", "thinking:off", "flush"]);
  assert.equal(configuration.provider, "xai");
  assert.equal(configuration.modelId, "grok-4.5");
  const published = events.find((event) => event.type === "session_snapshot");
  assert.equal(published?.type === "session_snapshot" ? published.snapshot.model?.provider : undefined, "xai");
  assert.equal(published?.type === "session_snapshot" ? published.snapshot.model?.id : undefined, "grok-4.5");
  assert.equal(published?.type === "session_snapshot" ? published.snapshot.thinkingLevel : undefined, "off");
});

test("a running session records a model switch for the next request", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-running-model-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const current = model("pierce", "gpt-5.6-sol");
  const next = model("xai", "grok-4.5");
  let setModelCalls = 0;
  let thinking: ThinkingLevel = "high";
  const session: ModelSessionDouble = {
    isStreaming: true,
    model: current,
    thinkingLevel: thinking,
    async setModel(selected) { setModelCalls += 1; this.model = selected; },
    setThinkingLevel(level) { thinking = level; this.thinkingLevel = level; },
    settingsManager: { async flush() {} },
  };
  const modelRuntime = {
    getModel: (provider: string, id: string) => provider === next.provider && id === next.id ? next : undefined,
    checkAuth: async () => true,
  } as unknown as ModelRuntime;
  const runtime = new CoilCoilRuntime({
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    modelRuntime,
  });
  const internals = runtime as unknown as RuntimeInternals;
  internals.active = { session };
  internals.snapshot = async () => snapshot(session);
  internals.getConfiguration = async () => ({
    provider: session.model?.provider,
    modelId: session.model?.id,
    thinkingLevel: session.thinkingLevel,
    configuredProviders: ["pierce", "xai"],
    models: [],
    migratedLegacyCredentials: false,
  });

  await runtime.setSessionModel({ provider: "xai", modelId: "grok-4.5", thinkingLevel: "off" });
  assert.equal(setModelCalls, 0);
  assert.equal(session.model, current);
  assert.equal(session.thinkingLevel, "high");
  assert.equal(thinking, "high");
  assert.deepEqual(internals.active?.pendingModel, {
    provider: "xai",
    id: "grok-4.5",
    name: "grok-4.5",
    reasoning: true,
    thinkingLevel: "off",
  });

  await internals.applyPendingSessionModel(internals.active!);
  assert.equal(setModelCalls, 1);
  assert.equal(session.model, next);
  assert.equal(session.thinkingLevel, "off");
  assert.equal(thinking, "off");
  assert.equal(internals.active?.pendingModel, undefined);
});
