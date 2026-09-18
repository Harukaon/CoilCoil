import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CoilCoilRuntime, CoilCoilRuntimeOptions } from "@coilcoil/runtime-core";
import type {
  PlanApprovalState,
  PlanExecutionTarget,
  RuntimeBootstrap,
  RuntimeEvent,
  RuntimeWireMessage,
  SessionSnapshot,
  SessionModelSelection,
} from "@coilcoil/runtime-protocol";
import { SESSION_OPEN_SUPERSEDED_ERROR } from "@coilcoil/runtime-protocol";
import { RuntimeServer } from "../src/index.js";

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

class FakeRuntime {
  private readonly emit: (event: RuntimeEvent) => void;
  private snapshotValue?: SessionSnapshot;
  readonly promptGate = deferred();
  readonly promptClientMessageIds: Array<string | undefined> = [];
  readonly createdWithModels: Array<SessionModelSelection | undefined> = [];
  readonly sessionModelChanges: SessionModelSelection[] = [];
  readonly sessionFastChanges: boolean[] = [];
  disposed = false;

  constructor(
    private readonly ordinal: number,
    options: CoilCoilRuntimeOptions,
    private readonly controls: {
      openGates?: Map<string, ReturnType<typeof deferred>>;
      openCalls?: Map<string, number>;
      snapshotCalls?: Map<string, number>;
      initialSubagentStatus?: "pending" | "running" | "completed" | "failed" | "stopped";
    } = {},
  ) {
    this.emit = options.onEvent ?? (() => undefined);
  }

  async initialize(): Promise<RuntimeBootstrap> {
    return {
      configuration: {
        thinkingLevel: "off",
        configuredProviders: [],
        models: [],
        migratedLegacyCredentials: false,
      },
    };
  }

  async sharedModelRuntime(): Promise<unknown> {
    return {};
  }

  refreshSessionModelFromRegistry(): void {}

  async getSkillConfiguration(cwd: string): Promise<{ cwd: string; ordinal: number }> {
    return { cwd, ordinal: this.ordinal };
  }

  async createSession(cwd: string, model?: SessionModelSelection): Promise<SessionSnapshot> {
    this.createdWithModels.push(model);
    return this.install(cwd, `${cwd}/session-${this.ordinal}.jsonl`);
  }

  async configureModel(input: SessionModelSelection): Promise<RuntimeBootstrap["configuration"]> {
    return {
      provider: input.provider,
      modelId: input.modelId,
      thinkingLevel: input.thinkingLevel,
      configuredProviders: [input.provider],
      models: [],
      migratedLegacyCredentials: false,
    };
  }

  async setSessionModel(input: SessionModelSelection & { type?: string }): Promise<RuntimeBootstrap["configuration"]> {
    const { provider, modelId, thinkingLevel } = input;
    this.sessionModelChanges.push({ provider, modelId, thinkingLevel });
    return this.configureModel({ provider, modelId, thinkingLevel });
  }

  async setSessionFast(enabled: boolean): Promise<boolean> {
    this.sessionFastChanges.push(enabled);
    if (this.snapshotValue) this.snapshotValue = { ...this.snapshotValue, fast: enabled };
    return enabled;
  }

  async openSession(cwd: string, sessionPath: string): Promise<SessionSnapshot> {
    this.controls.openCalls?.set(sessionPath, (this.controls.openCalls.get(sessionPath) ?? 0) + 1);
    await this.controls.openGates?.get(sessionPath)?.promise;
    return this.install(cwd, sessionPath);
  }

  private install(cwd: string, path: string): SessionSnapshot {
    const initialSubagent = this.controls.initialSubagentStatus ? [{
      id: `persisted-subagent-${this.ordinal}`,
      runId: `persisted-subagent-${this.ordinal}`,
      index: 0,
      agent: "worker",
      status: this.controls.initialSubagentStatus,
      background: true,
      controlReady: true,
      toolCount: 0,
      tokens: 0,
      durationMs: 0,
      updatedAt: Date.now(),
    } as const] : [];
    this.snapshotValue = {
      session: {
        id: `session-${this.ordinal}`,
        path,
        cwd,
        title: `会话 ${this.ordinal}`,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        messageCount: 0,
      },
      messages: [],
      promptQueue: [],
      tools: [],
      subagents: initialSubagent,
      project: { cwd, files: [], changes: [], terminals: [], plan: [], refreshedAt: 0 },
      thinkingLevel: "off",
      fast: false,
      responseMetricsHistory: [],
      tokenUsage: EMPTY_USAGE,
      runtimeInspection: { sessionRevision: 1, activeLeafId: undefined, summaryEvents: [] },
      running: false,
    };
    this.emit({ type: "session_snapshot", snapshot: this.snapshotValue });
    return this.snapshotValue;
  }

  async prompt(text: string, _images?: unknown[], clientMessageId?: string): Promise<{ accepted: true }> {
    if (!this.snapshotValue) throw new Error("No active session");
    this.promptClientMessageIds.push(clientMessageId);
    this.snapshotValue = { ...this.snapshotValue, running: true };
    this.emit({ type: "run_state", running: true });
    void this.promptGate.promise.then(() => {
      if (!this.snapshotValue || this.disposed) return;
      this.snapshotValue = {
        ...this.snapshotValue,
        running: false,
        messages: [
          ...this.snapshotValue.messages,
          { id: `assistant-${this.ordinal}`, order: 0, role: "assistant", text, timestamp: Date.now(), status: "succeeded" },
        ],
      };
      this.emit({ type: "message_finished", message: this.snapshotValue.messages.at(-1)!, revision: 1 });
      this.emit({ type: "run_state", running: false });
      this.emit({ type: "session_snapshot", snapshot: this.snapshotValue });
    });
    return { accepted: true };
  }

  async approvePlan(planId: string, target: PlanExecutionTarget, agent?: string): Promise<PlanApprovalState> {
    return {
      id: planId,
      title: "测试计划",
      markdown: "# 测试计划\n\n验证运行时路由。\n",
      filePath: "/tmp/plan.md",
      revision: 2,
      status: target === "main" ? "running" : "delegated",
      createdAt: 1,
      updatedAt: 2,
      executionTarget: target,
      agentProfile: agent,
    };
  }

  async rejectPlan(planId: string): Promise<PlanApprovalState> {
    return {
      id: planId,
      title: "测试计划",
      markdown: "# 测试计划\n\n验证运行时路由。\n",
      filePath: "/tmp/plan.md",
      revision: 2,
      status: "rejected",
      createdAt: 1,
      updatedAt: 2,
    };
  }

  async snapshot(): Promise<SessionSnapshot> {
    if (!this.snapshotValue) throw new Error("No active session");
    const path = this.snapshotValue.session.path;
    this.controls.snapshotCalls?.set(path, (this.controls.snapshotCalls.get(path) ?? 0) + 1);
    return this.snapshotValue;
  }

  emitMemoryState(state: "running" | "succeeded" | "failed"): void {
    if (!this.snapshotValue) throw new Error("No active session");
    const cwd = this.snapshotValue.session.cwd;
    const inspection = {
      ...this.snapshotValue.runtimeInspection,
      memory: {
        cwd,
        updatedAt: Date.now(),
        attemptId: `memory-${this.ordinal}`,
        state,
        source: "manual" as const,
        exists: true,
        injected: false,
        processedSessions: [],
      },
    };
    this.snapshotValue = { ...this.snapshotValue, runtimeInspection: inspection };
    this.emit({ type: "runtime_inspection_updated", inspection });
  }

  emitSubagentState(status: "pending" | "running" | "completed" | "failed" | "stopped"): void {
    if (!this.snapshotValue) throw new Error("No active session");
    const subagent = {
      id: `subagent-${this.ordinal}`,
      runId: `subagent-${this.ordinal}`,
      index: 0,
      agent: "worker",
      status,
      background: true,
      controlReady: status === "pending" || status === "running" ? true : undefined,
      toolCount: 0,
      tokens: 0,
      durationMs: 0,
      updatedAt: Date.now(),
    } as const;
    this.snapshotValue = { ...this.snapshotValue, subagents: [subagent] };
    this.emit({ type: "subagents_updated", subagents: [subagent] });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

test("one runtime server keeps multiple Agent sessions alive and independently scoped", async () => {
  const messages: RuntimeWireMessage[] = [];
  const runtimes: FakeRuntime[] = [];
  let runtimeId = 0;
  const server = new RuntimeServer(
    { agentDir: "/tmp/agent", sessionDir: "/tmp/sessions" },
    (message) => messages.push(message),
    {
      createRuntime: (options) => {
        const runtime = new FakeRuntime(runtimes.length, options);
        runtimes.push(runtime);
        return runtime as unknown as CoilCoilRuntime;
      },
      createRuntimeId: () => `runtime-${++runtimeId}`,
    },
  );

  const firstResponse = await server.handle({ id: "create-a", command: { type: "create_session", cwd: "/project-a" } });
  const first = firstResponse.result as SessionSnapshot;
  assert.equal(first.runtimeId, "runtime-1");
  await server.handle({ id: "prompt-a", runtimeId: first.runtimeId, command: { type: "prompt", text: "A 完成", images: [], clientMessageId: "client-a" } });

  const secondResponse = await server.handle({ id: "create-b", command: { type: "create_session", cwd: "/project-b" } });
  const second = secondResponse.result as SessionSnapshot;
  assert.equal(second.runtimeId, "runtime-2");
  await server.handle({ id: "prompt-b", runtimeId: second.runtimeId, command: { type: "prompt", text: "B 完成", images: [], clientMessageId: "client-b" } });
  assert.deepEqual(runtimes[1].promptClientMessageIds, ["client-a"]);
  assert.deepEqual(runtimes[2].promptClientMessageIds, ["client-b"]);

  const reopenedResponse = await server.handle({
    id: "reopen-a",
    command: { type: "open_session", cwd: "/project-a", sessionPath: first.session.path },
  });
  const reopened = reopenedResponse.result as SessionSnapshot;
  assert.equal(reopened.runtimeId, first.runtimeId);
  assert.equal(reopened.running, true, "switching away must not stop the first session");
  assert.equal(runtimes.length, 3, "the existing session must be reused instead of recreated");

  runtimes[2].promptGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await server.handle({
    id: "still-running-a",
    command: { type: "open_session", cwd: "/project-a", sessionPath: first.session.path },
  })).result && ((await runtimes[1].snapshot()).running), true);

  runtimes[1].promptGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  const completedA = (await server.handle({
    id: "completed-a",
    command: { type: "open_session", cwd: "/project-a", sessionPath: first.session.path },
  })).result as SessionSnapshot;
  assert.equal(completedA.running, false);
  assert.equal(completedA.messages.at(-1)?.text, "A 完成");

  const scopedRunEvents = messages.filter((message) => "event" in message && message.event.type === "run_state");
  assert.ok(scopedRunEvents.some((message) => "event" in message && message.runtimeId === first.runtimeId && message.event.type === "run_state" && message.event.running === false));
  assert.ok(scopedRunEvents.some((message) => "event" in message && message.runtimeId === second.runtimeId && message.event.type === "run_state" && message.event.running === false));

  await server.dispose();
  assert.ok(runtimes.every((runtime) => runtime.disposed));
});

test("model selection is explicit at session creation and later switches only the addressed runtime", async () => {
  const runtimes: FakeRuntime[] = [];
  let runtimeId = 0;
  const server = new RuntimeServer(
    { agentDir: "/tmp/agent", sessionDir: "/tmp/sessions" },
    () => undefined,
    {
      createRuntime: (options) => {
        const runtime = new FakeRuntime(runtimes.length, options);
        runtimes.push(runtime);
        return runtime as unknown as CoilCoilRuntime;
      },
      createRuntimeId: () => `runtime-${++runtimeId}`,
    },
  );

  const firstChoice: SessionModelSelection = { provider: "pierce", modelId: "gpt-5.6-sol", thinkingLevel: "high" };
  const firstResponse = await server.handle({
    id: "create-model-a",
    command: { type: "create_session", cwd: "/project-a", model: firstChoice },
  });
  const first = firstResponse.result as SessionSnapshot;
  assert.deepEqual(runtimes[1].createdWithModels, [firstChoice]);

  const secondResponse = await server.handle({ id: "create-model-b", command: { type: "create_session", cwd: "/project-b" } });
  const second = secondResponse.result as SessionSnapshot;
  const switched: SessionModelSelection = { provider: "xai", modelId: "grok-4.5", thinkingLevel: "off" };
  const switchResponse = await server.handle({
    id: "switch-model-a",
    runtimeId: first.runtimeId,
    command: { type: "set_session_model", ...switched },
  });

  assert.equal(switchResponse.ok, true);
  assert.deepEqual(runtimes[1].sessionModelChanges, [switched]);
  assert.deepEqual(runtimes[2].sessionModelChanges, [], "another live conversation must keep its own model");
  assert.notEqual(first.runtimeId, second.runtimeId);

  const fastResponse = await server.handle({
    id: "fast-model-a",
    runtimeId: first.runtimeId,
    command: { type: "set_session_fast", enabled: true },
  });
  assert.equal(fastResponse.ok, true);
  assert.deepEqual(runtimes[1].sessionFastChanges, [true]);
  assert.deepEqual(runtimes[2].sessionFastChanges, []);

  const missingRuntime = await server.handle({
    id: "switch-without-runtime",
    command: { type: "set_session_model", ...firstChoice },
  });
  assert.equal(missingRuntime.ok, false);
  assert.match(missingRuntime.error ?? "", /缺少会话标识/);

  const missingFastRuntime = await server.handle({
    id: "fast-without-runtime",
    command: { type: "set_session_fast", enabled: true },
  });
  assert.equal(missingFastRuntime.ok, false);
  assert.match(missingFastRuntime.error ?? "", /缺少会话标识/);

  await server.dispose();
});

test("changing the future-session default never falls back to the last active conversation", async () => {
  const runtimes: FakeRuntime[] = [];
  const server = new RuntimeServer(
    { agentDir: "/tmp/agent", sessionDir: "/tmp/sessions" },
    () => undefined,
    {
      createRuntime: (options) => {
        const runtime = new FakeRuntime(runtimes.length, options);
        runtimes.push(runtime);
        return runtime as unknown as CoilCoilRuntime;
      },
      createRuntimeId: () => "runtime-default-routing",
    },
  );

  await server.handle({ id: "create-active", command: { type: "create_session", cwd: "/project" } });
  const defaultChoice: SessionModelSelection = { provider: "pierce", modelId: "gpt-5.6-terra", thinkingLevel: "medium" };
  const response = await server.handle({ id: "configure-default", command: { type: "configure_model", ...defaultChoice } });
  assert.equal(response.ok, true);
  assert.deepEqual(runtimes[0].sessionModelChanges, []);
  assert.deepEqual(runtimes[1].sessionModelChanges, [], "the active conversation must not be mutated by a default-only command");

  await server.dispose();
});

test("plan approval commands are routed to the selected live session runtime", async () => {
  const server = new RuntimeServer(
    { agentDir: "/tmp/agent", sessionDir: "/tmp/sessions" },
    () => undefined,
    {
      createRuntime: (options) => new FakeRuntime(1, options) as unknown as CoilCoilRuntime,
      createRuntimeId: () => "runtime-plan",
    },
  );
  const created = await server.handle({ id: "create", command: { type: "create_session", cwd: "/project" } });
  const runtimeId = (created.result as SessionSnapshot).runtimeId;

  const delegated = await server.handle({
    id: "approve",
    runtimeId,
    command: { type: "approve_plan", planId: "plan-a", target: "subagent", agent: "worker" },
  });
  assert.equal((delegated.result as PlanApprovalState).status, "delegated");
  assert.equal((delegated.result as PlanApprovalState).agentProfile, "worker");

  const rejected = await server.handle({
    id: "reject",
    runtimeId,
    command: { type: "reject_plan", planId: "plan-b" },
  });
  assert.equal((rejected.result as PlanApprovalState).status, "rejected");
  await server.dispose();
});

test("repeated clicks share one in-flight historical session restore", async () => {
  const runtimes: FakeRuntime[] = [];
  const openGates = new Map([["/sessions/slow.jsonl", deferred()]]);
  const openCalls = new Map<string, number>();
  let runtimeId = 0;
  const server = new RuntimeServer(
    { agentDir: "/tmp/agent", sessionDir: "/tmp/sessions" },
    () => undefined,
    {
      createRuntime: (options) => {
        const runtime = new FakeRuntime(runtimes.length, options, { openGates, openCalls });
        runtimes.push(runtime);
        return runtime as unknown as CoilCoilRuntime;
      },
      createRuntimeId: () => `runtime-${++runtimeId}`,
    },
  );

  const requests = Array.from({ length: 30 }, (_, index) => server.handle({
    id: `open-${index}`,
    command: { type: "open_session", cwd: "/project", sessionPath: "/sessions/slow.jsonl" },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimes.length, 2, "one control runtime and one restoring session runtime should exist");
  assert.equal(openCalls.get("/sessions/slow.jsonl"), 1);

  openGates.get("/sessions/slow.jsonl")?.resolve();
  const responses = await Promise.all(requests);
  assert.ok(responses.every((response) => response.ok));
  assert.deepEqual(
    [...new Set(responses.map((response) => (response.result as SessionSnapshot).runtimeId))],
    ["runtime-1"],
  );
  await server.dispose();
});

test("settled session reopens reuse the latest immutable snapshot", async () => {
  const runtimes: FakeRuntime[] = [];
  const snapshotCalls = new Map<string, number>();
  let runtimeId = 0;
  const server = new RuntimeServer(
    { agentDir: "/tmp/agent", sessionDir: "/tmp/sessions" },
    () => undefined,
    {
      createRuntime: (options) => {
        const runtime = new FakeRuntime(runtimes.length, options, { snapshotCalls });
        runtimes.push(runtime);
        return runtime as unknown as CoilCoilRuntime;
      },
      createRuntimeId: () => `runtime-${++runtimeId}`,
    },
  );

  const command = { type: "open_session" as const, cwd: "/project", sessionPath: "/sessions/cached.jsonl" };
  assert.equal((await server.handle({ id: "first", command })).ok, true);
  for (let index = 0; index < 100; index += 1) {
    assert.equal((await server.handle({ id: `cached-${index}`, command })).ok, true);
  }
  assert.equal(snapshotCalls.get(command.sessionPath) ?? 0, 0, "clean session switching must not reconstruct history again");
  assert.equal(runtimes.length, 2);
  await server.dispose();
});

test("canonical and symlinked session paths reuse the same runtime", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-session-alias-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const realSessions = join(root, "sessions");
  const aliasSessions = join(root, "session-alias");
  mkdirSync(realSessions);
  symlinkSync(realSessions, aliasSessions, "dir");
  const aliasSessionPath = join(aliasSessions, "history.jsonl");
  const canonicalSessionPath = join(realpathSync(realSessions), "history.jsonl");

  const runtimes: FakeRuntime[] = [];
  const openCalls = new Map<string, number>();
  let runtimeId = 0;
  const server = new RuntimeServer(
    { agentDir: join(root, "agent"), sessionDir: realSessions },
    () => undefined,
    {
      createRuntime: (options) => {
        const runtime = new FakeRuntime(runtimes.length, options, { openCalls });
        runtimes.push(runtime);
        return runtime as unknown as CoilCoilRuntime;
      },
      createRuntimeId: () => `runtime-${++runtimeId}`,
    },
  );

  const first = await server.handle({
    id: "open-alias",
    command: { type: "open_session", cwd: root, sessionPath: aliasSessionPath },
  });
  const second = await server.handle({
    id: "open-canonical",
    command: { type: "open_session", cwd: root, sessionPath: canonicalSessionPath },
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal((first.result as SessionSnapshot).runtimeId, (second.result as SessionSnapshot).runtimeId);
  assert.equal(runtimes.length, 2, "path aliases must not construct a duplicate Pi runtime");
  assert.equal(openCalls.get(aliasSessionPath), 1);
  assert.equal(openCalls.get(canonicalSessionPath) ?? 0, 0);
  await server.dispose();
});

test("rapid navigation serializes restores and skips queued intermediate sessions", async () => {
  const runtimes: FakeRuntime[] = [];
  const firstGate = deferred();
  const openGates = new Map([["/sessions/a.jsonl", firstGate]]);
  const openCalls = new Map<string, number>();
  let runtimeId = 0;
  const server = new RuntimeServer(
    { agentDir: "/tmp/agent", sessionDir: "/tmp/sessions" },
    () => undefined,
    {
      createRuntime: (options) => {
        const runtime = new FakeRuntime(runtimes.length, options, { openGates, openCalls });
        runtimes.push(runtime);
        return runtime as unknown as CoilCoilRuntime;
      },
      createRuntimeId: () => `runtime-${++runtimeId}`,
    },
  );

  const first = server.handle({ id: "open-a", command: { type: "open_session", cwd: "/project", sessionPath: "/sessions/a.jsonl" } });
  await new Promise((resolve) => setImmediate(resolve));
  const intermediate = server.handle({ id: "open-b", command: { type: "open_session", cwd: "/project", sessionPath: "/sessions/b.jsonl" } });
  const latest = server.handle({ id: "open-c", command: { type: "open_session", cwd: "/project", sessionPath: "/sessions/c.jsonl" } });
  firstGate.resolve();

  const [firstResponse, intermediateResponse, latestResponse] = await Promise.all([first, intermediate, latest]);
  assert.equal(firstResponse.ok, true, "an already-running restore may finish and be cached");
  assert.equal(intermediateResponse.ok, false);
  assert.equal(intermediateResponse.error, SESSION_OPEN_SUPERSEDED_ERROR);
  assert.equal(latestResponse.ok, true);
  assert.equal(openCalls.get("/sessions/a.jsonl"), 1);
  assert.equal(openCalls.get("/sessions/b.jsonl") ?? 0, 0, "a queued stale restore must never allocate a Pi session");
  assert.equal(openCalls.get("/sessions/c.jsonl"), 1);
  assert.equal(runtimes.length, 3, "only control, first, and latest runtimes should be constructed");
  await server.dispose();
});

test("idle historical runtimes are bounded while recent sessions remain reopenable", async () => {
  const runtimes: FakeRuntime[] = [];
  const messages: RuntimeWireMessage[] = [];
  let runtimeId = 0;
  const server = new RuntimeServer(
    { agentDir: "/tmp/agent", sessionDir: "/tmp/sessions" },
    (message) => messages.push(message),
    {
      createRuntime: (options) => {
        const runtime = new FakeRuntime(runtimes.length, options);
        runtimes.push(runtime);
        return runtime as unknown as CoilCoilRuntime;
      },
      createRuntimeId: () => `runtime-${++runtimeId}`,
    },
  );

  for (let index = 0; index < 10; index += 1) {
    const response = await server.handle({
      id: `open-${index}`,
      command: { type: "open_session", cwd: "/project", sessionPath: `/sessions/${index}.jsonl` },
    });
    assert.equal(response.ok, true);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimes.filter((runtime) => !runtime.disposed).length, 7, "control plus six idle session runtimes should remain");
  assert.ok(runtimes.slice(1, 5).every((runtime) => runtime.disposed), "the least recently used idle sessions should be retired");
  const releasedRuntimeIds = messages.flatMap((message) =>
    "event" in message && message.event.type === "runtime_released" && message.runtimeId ? [message.runtimeId] : [],
  );
  assert.deepEqual(releasedRuntimeIds.slice(0, 4), ["runtime-1", "runtime-2", "runtime-3", "runtime-4"]);

  const reopened = await server.handle({
    id: "reopen-0",
    command: { type: "open_session", cwd: "/project", sessionPath: "/sessions/0.jsonl" },
  });
  assert.equal(reopened.ok, true, "an evicted idle session must transparently restore from disk");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimes.filter((runtime) => !runtime.disposed).length, 7);
  await server.dispose();
});

test("a background Memory job is retained beyond the idle runtime limit", async () => {
  const runtimes: FakeRuntime[] = [];
  let runtimeId = 0;
  const server = new RuntimeServer(
    { agentDir: "/tmp/agent", sessionDir: "/tmp/sessions" },
    () => undefined,
    {
      createRuntime: (options) => {
        const runtime = new FakeRuntime(runtimes.length, options);
        runtimes.push(runtime);
        return runtime as unknown as CoilCoilRuntime;
      },
      createRuntimeId: () => `runtime-${++runtimeId}`,
    },
  );

  await server.handle({
    id: "memory-session",
    command: { type: "open_session", cwd: "/project", sessionPath: "/sessions/memory.jsonl" },
  });
  runtimes[1].emitMemoryState("running");

  for (let index = 0; index < 10; index += 1) {
    assert.equal((await server.handle({
      id: `open-${index}`,
      command: { type: "open_session", cwd: "/project", sessionPath: `/sessions/other-${index}.jsonl` },
    })).ok, true);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimes[1].disposed, false, "a Memory worker must not be evicted as an idle Agent runtime");
  assert.equal(
    runtimes.filter((runtime) => !runtime.disposed).length,
    8,
    "control, one background worker, and six ordinary idle session runtimes should remain",
  );

  runtimes[1].emitMemoryState("succeeded");
  await server.handle({
    id: "open-after-memory",
    command: { type: "open_session", cwd: "/project", sessionPath: "/sessions/after-memory.jsonl" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimes[1].disposed, true, "the completed background runtime may return to normal LRU retirement");
  await server.dispose();
});

test("a background subagent is retained beyond the idle runtime limit", async () => {
  const runtimes: FakeRuntime[] = [];
  let runtimeId = 0;
  const server = new RuntimeServer(
    { agentDir: "/tmp/agent", sessionDir: "/tmp/sessions" },
    () => undefined,
    {
      createRuntime: (options) => {
        const runtime = new FakeRuntime(runtimes.length, options);
        runtimes.push(runtime);
        return runtime as unknown as CoilCoilRuntime;
      },
      createRuntimeId: () => `runtime-${++runtimeId}`,
    },
  );

  await server.handle({
    id: "subagent-session",
    command: { type: "open_session", cwd: "/project", sessionPath: "/sessions/subagent.jsonl" },
  });
  runtimes[1].emitSubagentState("running");

  for (let index = 0; index < 10; index += 1) {
    assert.equal((await server.handle({
      id: `open-subagent-${index}`,
      command: { type: "open_session", cwd: "/project", sessionPath: `/sessions/subagent-other-${index}.jsonl` },
    })).ok, true);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimes[1].disposed, false, "a live background subagent must not be evicted as an idle Agent runtime");
  assert.equal(
    runtimes.filter((runtime) => !runtime.disposed).length,
    8,
    "control, one background subagent runtime, and six ordinary idle session runtimes should remain",
  );

  runtimes[1].emitSubagentState("completed");
  await server.handle({
    id: "open-after-subagent",
    command: { type: "open_session", cwd: "/project", sessionPath: "/sessions/after-subagent.jsonl" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimes[1].disposed, true, "a completed background subagent runtime may return to normal LRU retirement");
  await server.dispose();
});

test("a stale persisted running subagent does not pin a restored runtime", async () => {
  const runtimes: FakeRuntime[] = [];
  let runtimeId = 0;
  const server = new RuntimeServer(
    { agentDir: "/tmp/agent", sessionDir: "/tmp/sessions" },
    () => undefined,
    {
      createRuntime: (options) => {
        const ordinal = runtimes.length;
        const runtime = new FakeRuntime(ordinal, options, ordinal === 1 ? { initialSubagentStatus: "running" } : undefined);
        runtimes.push(runtime);
        return runtime as unknown as CoilCoilRuntime;
      },
      createRuntimeId: () => `runtime-${++runtimeId}`,
    },
  );

  await server.handle({
    id: "stale-subagent-session",
    command: { type: "open_session", cwd: "/project", sessionPath: "/sessions/stale-subagent.jsonl" },
  });
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await server.handle({
      id: `open-after-stale-${index}`,
      command: { type: "open_session", cwd: "/project", sessionPath: `/sessions/stale-other-${index}.jsonl` },
    })).ok, true);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimes[1].disposed, true, "persisted liveness from an earlier process must not pin a runtime");
  assert.equal(runtimes.filter((runtime) => !runtime.disposed).length, 7);
  await server.dispose();
});

test("workspace Memory changes invalidate cached sibling session snapshots", async () => {
  const runtimes: FakeRuntime[] = [];
  const snapshotCalls = new Map<string, number>();
  let runtimeId = 0;
  const server = new RuntimeServer(
    { agentDir: "/tmp/agent", sessionDir: "/tmp/sessions" },
    () => undefined,
    {
      createRuntime: (options) => {
        const runtime = new FakeRuntime(runtimes.length, options, { snapshotCalls });
        runtimes.push(runtime);
        return runtime as unknown as CoilCoilRuntime;
      },
      createRuntimeId: () => `runtime-${++runtimeId}`,
    },
  );

  const firstPath = "/sessions/workspace-a.jsonl";
  const secondPath = "/sessions/workspace-b.jsonl";
  await server.handle({ id: "open-a", command: { type: "open_session", cwd: "/project", sessionPath: firstPath } });
  await server.handle({ id: "open-b", command: { type: "open_session", cwd: "/project", sessionPath: secondPath } });
  await server.handle({ id: "cached-a", command: { type: "open_session", cwd: "/project", sessionPath: firstPath } });
  assert.equal(snapshotCalls.get(firstPath) ?? 0, 0);

  runtimes[2].emitMemoryState("running");
  await server.handle({ id: "refresh-a", command: { type: "open_session", cwd: "/project", sessionPath: firstPath } });
  assert.equal(snapshotCalls.get(firstPath), 1, "same-workspace Memory updates must mark sibling snapshots dirty");
  await server.dispose();
});

test("shutdown disposes every runtime even when the parent channel is already gone", async () => {
  const runtimes: FakeRuntime[] = [];
  let runtimeId = 0;
  const server = new RuntimeServer(
    { agentDir: "/tmp/agent", sessionDir: "/tmp/sessions" },
    (message) => {
      // What the real IPC sink used to do once the parent had disconnected: the
      // release notice threw, dispose stopped there, and the runtimes it had not
      // reached yet were never closed.
      if ("event" in message && message.event.type === "runtime_released") throw new Error("write EPIPE");
    },
    {
      createRuntime: (options) => {
        const runtime = new FakeRuntime(runtimes.length, options);
        runtimes.push(runtime);
        return runtime as unknown as CoilCoilRuntime;
      },
      createRuntimeId: () => `runtime-${++runtimeId}`,
    },
  );

  await server.handle({ id: "open-a", command: { type: "open_session", cwd: "/project", sessionPath: "/sessions/a.jsonl" } });
  await server.handle({ id: "open-b", command: { type: "open_session", cwd: "/project", sessionPath: "/sessions/b.jsonl" } });

  await server.dispose();
  assert.equal(runtimes.every((runtime) => runtime.disposed), true, "a failing release notice must not abort the cleanup");
});

test("workspace configuration reads survive a session runtime retired for idleness", async () => {
  const runtimes: FakeRuntime[] = [];
  let runtimeId = 0;
  const server = new RuntimeServer(
    { agentDir: "/tmp/agent", sessionDir: "/tmp/sessions" },
    () => undefined,
    {
      createRuntime: (options) => {
        const runtime = new FakeRuntime(runtimes.length, options);
        runtimes.push(runtime);
        return runtime as unknown as CoilCoilRuntime;
      },
      createRuntimeId: () => `runtime-${++runtimeId}`,
    },
  );

  await server.handle({ id: "open", command: { type: "open_session", cwd: "/project", sessionPath: "/sessions/a.jsonl" } });

  // The panels keep the runtime id they were opened with, and an idle runtime is
  // retired without telling them. Reading the workspace's skills must not depend
  // on that conversation still being in memory.
  const skills = await server.handle({
    id: "skills",
    runtimeId: "runtime-retired",
    command: { type: "get_skill_configuration", cwd: "/project" },
  });
  assert.equal(skills.ok, true);
  assert.deepEqual(skills.result, { cwd: "/project", ordinal: 0 }, "the control runtime answers workspace reads");

  const prompt = await server.handle({
    id: "prompt",
    runtimeId: "runtime-retired",
    command: { type: "prompt", text: "继续", images: [], clientMessageId: "client-retired" },
  });
  assert.equal(prompt.ok, false, "session-scoped commands still refuse a runtime that is gone");

  await server.dispose();
});
