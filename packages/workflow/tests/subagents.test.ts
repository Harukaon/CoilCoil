import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import subagentsExtension from "../extensions/subagents.ts";
import { readChildMeta, scanResumableChildren } from "../extensions/subagents/child.ts";
import {
  clampText,
  createRunId,
  type ChildRun,
  runIsLive,
  SubagentRegistry,
} from "../extensions/subagents/registry.ts";
import { SUBAGENT_RPC_REQUEST_CHANNEL, subagentRpcReplyChannel } from "../extensions/subagents/types.ts";

interface Emission {
  channel: string;
  payload: unknown;
}

function createHarness() {
  const eventHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const busListeners = new Map<string, Array<(payload: unknown) => unknown>>();
  const emissions: Emission[] = [];
  const tools: Array<Record<string, unknown>> = [];
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      const current = eventHandlers.get(name) ?? [];
      current.push(handler);
      eventHandlers.set(name, current);
    },
    registerTool(tool: Record<string, unknown>) {
      tools.push(tool);
    },
    events: {
      on(channel: string, listener: (payload: unknown) => unknown) {
        const current = busListeners.get(channel) ?? [];
        current.push(listener);
        busListeners.set(channel, current);
      },
      emit(channel: string, payload: unknown) {
        emissions.push({ channel, payload });
        for (const listener of busListeners.get(channel) ?? []) void listener(payload);
      },
    },
  };
  subagentsExtension(pi as never);
  const tool = tools.find((entry) => entry.name === "subagent");
  assert.ok(tool, "subagent tool must be registered");
  return {
    emissions,
    eventHandlers,
    execute: tool.execute as (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown>; isError?: boolean }>,
    emitRpc: (payload: Record<string, unknown>) => {
      for (const listener of busListeners.get(SUBAGENT_RPC_REQUEST_CHANNEL) ?? []) void listener(payload);
    },
  };
}

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp/suocode-subagents-test",
    model: undefined,
    modelRegistry: {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    },
    sessionManager: { getSessionDir: () => "/tmp/suocode-subagents-test/sessions" },
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("subagent tool registers with run/status actions", () => {
  const { execute } = createHarness();
  assert.equal(typeof execute, "function");
});

test("run rejects a missing task", async () => {
  const { execute } = createHarness();
  const result = await execute("call-1", {}, undefined, undefined, createContext());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /缺少子 Agent 任务描述/);
});

test("run rejects a malformed model override", async () => {
  const { execute } = createHarness();
  const result = await execute("call-2", { task: "看一下 README", model: "no-slash" }, undefined, undefined, createContext());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /模型格式无效/);
});

test("run rejects an unknown model", async () => {
  const { execute } = createHarness();
  const result = await execute("call-3", { task: "看一下 README", model: "prov/unknown" }, undefined, undefined, createContext());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /未找到模型/);
});

test("run rejects a model without configured auth", async () => {
  const { execute } = createHarness();
  const ctx = createContext({
    modelRegistry: {
      find: () => ({ provider: "prov", id: "locked" }),
      hasConfiguredAuth: () => false,
    },
  });
  const result = await execute("call-4", { task: "看一下 README", model: "prov/locked" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /尚未配置 API Key/);
});

test("status reports an empty registry", async () => {
  const { execute } = createHarness();
  const result = await execute("call-5", { action: "status" }, undefined, undefined, createContext());
  assert.match(result.content[0].text, /还没有派发过子 Agent/);
});

test("status rejects an unknown run id", async () => {
  const { execute } = createHarness();
  const result = await execute("call-6", { action: "status", runId: "missing" }, undefined, undefined, createContext());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /未找到子 Agent 运行/);
});

test("rpc stop rejects an unknown run", async () => {
  const { emitRpc, emissions } = createHarness();
  emitRpc({ version: 1, requestId: "req-1", method: "stop", params: { id: "missing" }, source: { client: "test" } });
  await settle();
  const reply = emissions.find((entry) => entry.channel === subagentRpcReplyChannel("req-1"));
  assert.ok(reply, "rpc reply must be emitted");
  const payload = reply.payload as { success: boolean; error?: { message?: string } };
  assert.equal(payload.success, false);
  assert.match(payload.error?.message ?? "", /未找到子 Agent 运行/);
});

test("rpc status rejects an unknown run", async () => {
  const { emitRpc, emissions } = createHarness();
  emitRpc({ version: 1, requestId: "req-2", method: "status", params: { id: "missing" }, source: { client: "test" } });
  await settle();
  const reply = emissions.find((entry) => entry.channel === subagentRpcReplyChannel("req-2"));
  assert.ok(reply);
  assert.equal((reply.payload as { success: boolean }).success, false);
});

test("rpc rejects unsupported methods", async () => {
  const { emitRpc, emissions } = createHarness();
  emitRpc({ version: 1, requestId: "req-3", method: "steer", params: { id: "x" } });
  await settle();
  const reply = emissions.find((entry) => entry.channel === subagentRpcReplyChannel("req-3"));
  assert.ok(reply);
  const payload = reply.payload as { success: boolean; error?: { message?: string } };
  assert.equal(payload.success, false);
  assert.match(payload.error?.message ?? "", /不支持/);
});

test("rpc resume rejects an unknown run", async () => {
  const { emitRpc, emissions } = createHarness();
  emitRpc({ version: 1, requestId: "req-4", method: "resume", params: { id: "missing" } });
  await settle();
  const reply = emissions.find((entry) => entry.channel === subagentRpcReplyChannel("req-4"));
  assert.ok(reply);
  const payload = reply.payload as { success: boolean; error?: { message?: string } };
  assert.equal(payload.success, false);
  assert.match(payload.error?.message ?? "", /未找到/);
});

test("stop requires a run id", async () => {
  const { execute } = createHarness();
  const result = await execute("call-7", { action: "stop" }, undefined, undefined, createContext());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /runId/);
});

test("stop rejects an unknown run", async () => {
  const { execute } = createHarness();
  const result = await execute("call-8", { action: "stop", runId: "missing" }, undefined, undefined, createContext());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /未找到/);
});

test("resume requires a run id", async () => {
  const { execute } = createHarness();
  const result = await execute("call-9", { action: "resume" }, undefined, undefined, createContext());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /runId/);
});

test("resume rejects an unknown run", async () => {
  const { execute } = createHarness();
  const ctx = createContext({
    sessionManager: { getSessionDir: () => "/tmp/does-not-exist-suocode-subagents" },
  });
  const result = await execute("call-10", { action: "resume", runId: "missing" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /未找到/);
});

test("child meta round-trips through persisted session files", () => {
  const dir = mkdtempSync(join(tmpdir(), "suocode-subagent-scan-"));
  mkdirSync(dir, { recursive: true });
  const meta = {
    runId: "sa-scan-test",
    agent: "worker",
    task: "写点东西",
    background: true,
    startedAt: Date.now(),
  };
  const sessionFile = join(dir, "2026-08-10T00-00-00-000Z_sa-scan-test.jsonl");
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "sa-scan-test" }),
    JSON.stringify({ type: "custom", customType: "suocode-subagent-meta", data: meta }),
  ];
  writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf8");

  const scanned = scanResumableChildren(dir);
  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].meta.runId, "sa-scan-test");
  assert.equal(scanned[0].meta.background, true);
  assert.equal(scanned[0].sessionFile, sessionFile);
  assert.equal(readChildMeta(sessionFile)?.agent, "worker");
  assert.equal(scanResumableChildren(join(dir, "nope")).length, 0);
});

function makeRun(overrides: Partial<ChildRun> = {}): ChildRun {
  return {
    runId: "sa-test-run",
    agent: "explore",
    task: "搜索配置",
    background: false,
    status: "running",
    startedAt: Date.now() - 1_000,
    recentTools: [],
    recentOutput: [],
    messages: [],
    toolCalls: [],
    toolCount: 0,
    turnCount: 0,
    tokens: 0,
    bashBuffer: "",
    ...overrides,
  };
}

test("registry resolves runs by id prefix", () => {
  const registry = new SubagentRegistry();
  const run = makeRun();
  registry.add(run);
  registry.add(makeRun({ runId: "sa-other-run" }));
  assert.equal(registry.get("sa-test")?.runId, "sa-test-run");
  assert.equal(registry.get("sa-"), undefined, "ambiguous prefixes must not resolve");
  assert.equal(registry.get("nope"), undefined);
});

test("registry activity reflects live and terminal states", () => {
  const registry = new SubagentRegistry();
  const live = makeRun({ session: {} as ChildRun["session"] });
  const done = makeRun({ runId: "sa-done", status: "completed", finishedAt: Date.now(), finalOutput: "完成", sessionFile: "/tmp/x.jsonl" });
  registry.add(live);
  registry.add(done);
  const liveActivity = registry.toActivity(live);
  const doneActivity = registry.toActivity(done);
  assert.equal(liveActivity.controlReady, true);
  assert.equal(liveActivity.resumable, undefined);
  assert.equal(runIsLive(live), true);
  assert.equal(doneActivity.resumable, true);
  assert.equal(doneActivity.controlReady, undefined);
  assert.equal(doneActivity.finalOutput, "完成");
  assert.equal(registry.liveCount(), 1);
});

test("registry caps recent output entries", () => {
  const registry = new SubagentRegistry();
  const run = makeRun();
  for (let index = 0; index < 40; index += 1) registry.recordRecentOutput(run, `line ${index}`);
  assert.equal(run.recentOutput.length, 24);
  assert.match(run.recentOutput.at(-1) ?? "", /line 39/);
});

test("createRunId produces unique prefixed ids", () => {
  const ids = new Set(Array.from({ length: 200 }, () => createRunId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^sa-[a-z0-9]+-[a-z0-9]+$/);
});

test("clampText truncates long values", () => {
  assert.equal(clampText("abc", 10), "abc");
  const clamped = clampText("a".repeat(100), 10);
  assert.ok(clamped.startsWith("aaaaaaaaaa"));
  assert.match(clamped, /已截断/);
});
