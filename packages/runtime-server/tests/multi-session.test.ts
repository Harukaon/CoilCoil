import assert from "node:assert/strict";
import test from "node:test";
import type { SuoCodeRuntime, SuoCodeRuntimeOptions } from "@suocode/runtime-core";
import type {
  RuntimeBootstrap,
  RuntimeEvent,
  RuntimeWireMessage,
  SessionSnapshot,
} from "@suocode/runtime-protocol";
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
  disposed = false;

  constructor(private readonly ordinal: number, options: SuoCodeRuntimeOptions) {
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

  async createSession(cwd: string): Promise<SessionSnapshot> {
    return this.install(cwd, `${cwd}/session-${this.ordinal}.jsonl`);
  }

  async openSession(cwd: string, sessionPath: string): Promise<SessionSnapshot> {
    return this.install(cwd, sessionPath);
  }

  private install(cwd: string, path: string): SessionSnapshot {
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
      tools: [],
      subagents: [],
      project: { cwd, files: [], changes: [], terminals: [], plan: [], refreshedAt: 0 },
      thinkingLevel: "off",
      responseMetricsHistory: [],
      tokenUsage: EMPTY_USAGE,
      running: false,
    };
    this.emit({ type: "session_snapshot", snapshot: this.snapshotValue });
    return this.snapshotValue;
  }

  async prompt(text: string): Promise<{ accepted: true }> {
    if (!this.snapshotValue) throw new Error("No active session");
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
      this.emit({ type: "message_finished", message: this.snapshotValue.messages.at(-1)! });
      this.emit({ type: "run_state", running: false });
      this.emit({ type: "session_snapshot", snapshot: this.snapshotValue });
    });
    return { accepted: true };
  }

  async snapshot(): Promise<SessionSnapshot> {
    if (!this.snapshotValue) throw new Error("No active session");
    return this.snapshotValue;
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
        return runtime as unknown as SuoCodeRuntime;
      },
      createRuntimeId: () => `runtime-${++runtimeId}`,
    },
  );

  const firstResponse = await server.handle({ id: "create-a", command: { type: "create_session", cwd: "/project-a" } });
  const first = firstResponse.result as SessionSnapshot;
  assert.equal(first.runtimeId, "runtime-1");
  await server.handle({ id: "prompt-a", runtimeId: first.runtimeId, command: { type: "prompt", text: "A 完成", images: [] } });

  const secondResponse = await server.handle({ id: "create-b", command: { type: "create_session", cwd: "/project-b" } });
  const second = secondResponse.result as SessionSnapshot;
  assert.equal(second.runtimeId, "runtime-2");
  await server.handle({ id: "prompt-b", runtimeId: second.runtimeId, command: { type: "prompt", text: "B 完成", images: [] } });

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
