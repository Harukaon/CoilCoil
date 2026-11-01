import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CoilCoilRuntime, CoilCoilRuntimeOptions } from "@coilcoil/runtime-core";
import type { RuntimeCommand, RuntimeWireMessage, SessionSnapshot } from "@coilcoil/runtime-protocol";
import { RuntimeServer } from "../src/index.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class LifecycleRuntime {
  readonly createEntered = deferred();
  createGate?: ReturnType<typeof deferred>;
  commandGates: Array<ReturnType<typeof deferred>> = [];
  commandCalls = 0;
  deleteGate?: ReturnType<typeof deferred>;
  readonly deleteEntered = deferred();
  deleteError?: Error;
  readonly deletedWorkspaces: string[] = [];
  mutationGate?: ReturnType<typeof deferred>;
  readonly mutationEntered = deferred();
  mutationError?: Error;
  readonly mutations: string[] = [];
  beforeMutation?: () => void;
  disposeGate?: ReturnType<typeof deferred>;
  disposeCalls = 0;
  resourceAlive = false;
  snapshotValue?: SessionSnapshot;

  constructor(readonly ordinal: number, private readonly options: CoilCoilRuntimeOptions) {}

  async sharedModelRuntime() { return {}; }
  async initialize() { return {}; }
  async createSession(cwd: string): Promise<SessionSnapshot> {
    this.createEntered.resolve();
    await this.createGate?.promise;
    return this.install(cwd, join(cwd, `session-${this.ordinal}.jsonl`));
  }
  async openSession(cwd: string, sessionPath: string): Promise<SessionSnapshot> {
    this.createEntered.resolve();
    await this.createGate?.promise;
    return this.install(cwd, sessionPath);
  }
  private install(cwd: string, sessionPath: string): SessionSnapshot {
    this.resourceAlive = true;
    this.snapshotValue = {
      session: { id: `session-${this.ordinal}`, path: sessionPath, cwd, title: "fixture", createdAt: "", updatedAt: "", messageCount: 0 },
      messages: [], promptQueue: [], tools: [], subagents: [],
      project: { cwd, files: [], changes: [], terminals: [], refreshedAt: 0 },
      thinkingLevel: "off", fast: false, responseMetricsHistory: [],
      tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      runtimeInspection: { sessionRevision: 1, summaryEvents: [] }, running: false,
    };
    this.options.onEvent?.({ type: "session_snapshot", snapshot: this.snapshotValue });
    return this.snapshotValue;
  }
  async setSessionFast(enabled: boolean) {
    const gate = this.commandGates[this.commandCalls++];
    await gate?.promise;
    if (!this.resourceAlive) throw new Error("session was disposed during the command");
    return enabled;
  }
  async snapshot() { return this.snapshotValue!; }
  async steer(text: string, _images?: unknown[], clientMessageId?: string) {
    const steering = { id: clientMessageId!, text, timestamp: 1 };
    const revision = (this.snapshotValue!.messageRevision ?? 0) + 1;
    this.snapshotValue = { ...this.snapshotValue!, messageRevision: revision, steering: [steering] };
    this.options.onEvent?.({ type: "message_steering", ...steering, revision });
    return { accepted: true, steered: true };
  }
  rejectSteering(id: string) {
    const revision = (this.snapshotValue!.messageRevision ?? 0) + 1;
    this.snapshotValue = { ...this.snapshotValue!, messageRevision: revision, steering: [] };
    this.options.onEvent?.({ type: "message_rejected", id, revision });
  }
  setRunning(running: boolean) {
    if (this.snapshotValue) this.snapshotValue = { ...this.snapshotValue, running };
    this.options.onEvent?.({ type: "run_state", running });
  }
  emitMemoryRunning() {
    this.options.onEvent?.({ type: "runtime_inspection_updated", inspection: {
      sessionRevision: 1, summaryEvents: [], memory: { cwd: this.snapshotValue!.session.cwd, updatedAt: 0, state: "running", exists: false, injected: false, source: "manual", processedSessions: [] },
    } });
  }
  emitSubagentRunning() {
    this.options.onEvent?.({ type: "subagents_updated", subagents: [{ id: "child", runId: "child", index: 0, agent: "fixture", status: "running", controlReady: true, background: true, toolCount: 0, tokens: 0, durationMs: 0, updatedAt: 0 }] });
  }
  async accessMcp() { await this.commandGates[0]?.promise; return {}; }
  private async mutate(kind: string) {
    this.beforeMutation?.();
    this.mutations.push(kind);
    this.mutationEntered.resolve();
    await this.mutationGate?.promise;
    if (this.mutationError) throw this.mutationError;
    return [];
  }
  async deleteSession() { return this.mutate("delete"); }
  async archiveSession() { return this.mutate("archive"); }
  async moveSession() { return this.mutate("move"); }
  async restoreSession() { return this.mutate("restore"); }
  async renameSession() { return this.mutate("rename"); }
  async pinSession() { return this.mutate("pin"); }
  async forkSession() { return this.mutate("fork"); }
  async deleteWorkspaceSessions(cwd: string) {
    this.deletedWorkspaces.push(cwd);
    this.deleteEntered.resolve();
    await this.deleteGate?.promise;
    if (this.deleteError) throw this.deleteError;
    return { deleted: 2 };
  }
  async dispose() { this.disposeCalls += 1; await this.disposeGate?.promise; this.resourceAlive = false; }
}

function fixture(t: { after(fn: () => unknown): void }, configure?: (runtime: LifecycleRuntime) => void) {
  const directory = mkdtempSync(join(tmpdir(), "coilcoil-server-lifecycle-"));
  const runtimes: LifecycleRuntime[] = [];
  const messages: RuntimeWireMessage[] = [];
  const server = new RuntimeServer({ agentDir: join(directory, "agent"), sessionDir: join(directory, "sessions") },
    (message) => messages.push(message), {
      createRuntime(options) {
        const runtime = new LifecycleRuntime(runtimes.length, options);
        configure?.(runtime);
        runtimes.push(runtime);
        return runtime as unknown as CoilCoilRuntime;
      },
      createRuntimeId: () => `runtime-${runtimes.length}`,
    });
  t.after(async () => { await server.dispose(); rmSync(directory, { recursive: true, force: true }); });
  let requestId = 0;
  const request = (command: RuntimeCommand, runtimeId?: string) => server.handle({ id: `request-${++requestId}`, runtimeId, command });
  const create = (name: string) => request({ type: "create_session", cwd: join(directory, name) });
  return { directory, server, runtimes, messages, request, create };
}

test("shutdown rejects new commands before allocating or invoking a runtime", async (t) => {
  const { server, runtimes, create, request } = fixture(t);
  await server.dispose();
  const created = await create("after-close");
  assert.equal(created.ok, false);
  assert.match(created.error ?? "", /关闭/);
  assert.equal(runtimes.length, 1, "closed servers must not allocate another session");
  assert.equal((await request({ type: "bootstrap" })).ok, false);
});

test("a session initialization completing after shutdown cannot resurrect runtime state or resources", async (t) => {
  const gate = deferred();
  const { server, runtimes, messages, create } = fixture(t, (runtime) => { if (runtime.ordinal === 1) runtime.createGate = gate; });
  const pending = create("slow");
  await runtimes[1].createEntered.promise;
  await server.dispose();
  const afterClose = messages.length;
  gate.resolve();
  const response = await pending;
  assert.equal(response.ok, false, "late initialization must fail instead of returning a released runtime id");
  assert.equal(runtimes[1].resourceAlive, false, "resources installed after the first dispose still need cleanup");
  assert.equal(messages.length, afterClose, "shutdown must suppress late session snapshot events");
});

test("LRU retirement does not dispose a session while its initialization is pending", async (t) => {
  const gate = deferred();
  const { runtimes, create, request } = fixture(t, (runtime) => { if (runtime.ordinal === 1) runtime.createGate = gate; });
  const pending = create("initializing");
  await runtimes[1].createEntered.promise;
  try {
    for (let index = 0; index < 10; index++) assert.equal((await create(`other-${index}`)).ok, true);
    assert.equal(runtimes[1].disposeCalls, 0, "initialization is live work even before the first run_state event");
  } finally { gate.resolve(); }
  const created = await pending;
  assert.equal(created.ok, true);
  assert.equal((await request({ type: "set_session_fast", enabled: true }, (created.result as SessionSnapshot).runtimeId)).ok, true);
});

test("simultaneous initialization completions cannot reinsert snapshots of retired runtimes", async (t) => {
  const gate = deferred();
  const { server, runtimes, create } = fixture(t, (runtime) => { if (runtime.ordinal > 0) runtime.createGate = gate; });
  const pending = Array.from({ length: 12 }, (_, index) => create(`parallel-${index}`));
  await Promise.all(runtimes.slice(1).map((runtime) => runtime.createEntered.promise));
  gate.resolve();
  await Promise.all(pending);
  const contexts = await server.accessMcp({ action: "contexts" }) as { contexts: Array<{ runtimeId: string }> };
  const alive = runtimes.filter((runtime) => runtime.ordinal > 0 && runtime.resourceAlive).map((runtime) => `runtime-${runtime.ordinal}`);
  assert.deepEqual(contexts.contexts.map((entry) => entry.runtimeId).sort(), alive.sort());
  assert.equal(alive.length, 6);
});

test("overlapping async session commands pin their runtime until the last command settles", async (t) => {
  const { runtimes, create, request } = fixture(t);
  const first = (await create("first")).result as SessionSnapshot;
  const a = deferred();
  const b = deferred();
  runtimes[1].commandGates.push(a, b);
  const pendingA = request({ type: "set_session_fast", enabled: true }, first.runtimeId);
  const pendingB = request({ type: "set_session_fast", enabled: false }, first.runtimeId);
  try {
    for (let index = 0; index < 10; index++) await create(`other-${index}`);
    assert.equal(runtimes[1].disposeCalls, 0, "commands awaiting configuration must not be cancelled by navigation");
    a.resolve();
    assert.equal((await pendingA).ok, true);
    await create("after-one-completes");
    assert.equal(runtimes[1].disposeCalls, 0, "one completion must not unpin a second pending command");
    b.resolve();
    assert.equal((await pendingB).ok, true);
    await create("after-both-complete");
    assert.equal(runtimes.filter((runtime) => runtime.ordinal > 0 && runtime.resourceAlive).length, 6, "normal LRU retirement resumes when commands settle");
  } finally { a.resolve(); b.resolve(); await Promise.all([pendingA, pendingB]); }
});

test("deleting workspace records closes its idle sessions and invalidates their runtime ids", async (t) => {
  const { directory, runtimes, messages, create, request } = fixture(t);
  const a = (await create("target")).result as SessionSnapshot;
  const b = (await create("target")).result as SessionSnapshot;
  const other = (await create("other")).result as SessionSnapshot;
  const deleted = await request({ type: "delete_workspace_sessions", cwd: join(directory, "target") });
  assert.equal(deleted.ok, true);
  assert.equal(runtimes[1].resourceAlive, false, "a deleted session must not remain available to write its file again");
  assert.equal(runtimes[2].resourceAlive, false);
  assert.equal(runtimes[3].resourceAlive, true);
  for (const snapshot of [a, b]) {
    assert.equal((await request({ type: "set_session_fast", enabled: true }, snapshot.runtimeId)).ok, false);
    assert.ok(messages.some((message) => "event" in message && message.event.type === "runtime_released" && message.runtimeId === snapshot.runtimeId));
  }
  assert.equal((await request({ type: "set_session_fast", enabled: true }, other.runtimeId)).ok, true);
});

test("workspace deletion refuses running and initializing sessions before touching any records", async (t) => {
  const { directory, runtimes, create, request } = fixture(t);
  await create("target");
  runtimes[1].setRunning(true);
  const command = { type: "delete_workspace_sessions" as const, cwd: join(directory, "target") };
  assert.equal((await request(command)).ok, false);
  assert.deepEqual(runtimes[0].deletedWorkspaces, []);
  assert.equal(runtimes[1].disposeCalls, 0);
  runtimes[1].setRunning(false);
  const gate = deferred();
  // The next allocation pauses before it has a snapshot or session-path index.
  const original = LifecycleRuntime.prototype.createSession;
  t.mock.method(LifecycleRuntime.prototype, "createSession", async function(this: LifecycleRuntime, cwd: string) {
    if (this.ordinal === 2) this.createGate = gate;
    return original.call(this, cwd);
  });
  const pending = create("target");
  await runtimes[2].createEntered.promise;
  try {
    assert.equal((await request(command)).ok, false);
    assert.deepEqual(runtimes[0].deletedWorkspaces, []);
    assert.equal(runtimes[1].disposeCalls, 0, "check every live runtime before releasing any of them");
  } finally { gate.resolve(); await pending; }
  assert.equal((await request(command)).ok, true, "a rejected deletion must release its workspace lock");
});

test("workspace deletion blocks reopen/create until disk work settles and releases the lock after failure", async (t) => {
  const { directory, runtimes, create, request } = fixture(t);
  const a = (await create("target")).result as SessionSnapshot;
  const gate = deferred();
  runtimes[0].deleteGate = gate;
  runtimes[0].deleteError = new Error("fixture deletion failed");
  const command = { type: "delete_workspace_sessions" as const, cwd: join(directory, "target") };
  const deleting = request(command);
  await runtimes[0].deleteEntered.promise;
  try {
    assert.equal((await create("target")).ok, false, "creating a session during deletion would recreate deleted records");
    assert.equal((await request({ type: "open_session", cwd: command.cwd, sessionPath: a.session.path })).ok, false);
    assert.equal((await request(command)).ok, false, "duplicate deletion must not race the first command");
    assert.equal(runtimes[0].deletedWorkspaces.length, 1);
    assert.equal((await create("other")).ok, true, "unrelated workspaces remain usable");
  } finally { gate.resolve(); }
  assert.equal((await deleting).ok, false);
  assert.equal((await create("target")).ok, true, "failed disk deletion must unlock the workspace");
});

const sessionActions = ["delete_session", "archive_session", "move_session"] as const;
function sessionAction(type: typeof sessionActions[number], snapshot: SessionSnapshot, targetCwd: string): RuntimeCommand {
  const input = { cwd: snapshot.session.cwd, sessionPath: snapshot.session.path };
  return type === "move_session" ? { type, ...input, targetCwd } : { type, ...input };
}

for (const action of sessionActions) {
  test(`${action} closes idle writers before disk changes and locks the path through disposal and failure`, async (t) => {
    const { directory, runtimes, create, request } = fixture(t);
    const snapshot = (await create("source")).result as SessionSnapshot;
    const disposeGate = deferred();
    const mutationGate = deferred();
    runtimes[1].disposeGate = disposeGate;
    runtimes[0].mutationGate = mutationGate;
    runtimes[0].mutationError = new Error("fixture mutation failed");
    runtimes[0].beforeMutation = () => assert.equal(runtimes[1].resourceAlive, false, "disk writes must follow complete writer shutdown");
    const command = sessionAction(action, snapshot, join(directory, "target"));
    const pending = request(command);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(runtimes[1].disposeCalls, 1);
      assert.deepEqual(runtimes[0].mutations, [], "disk mutation must wait for asynchronous disposal");
      for (const conflict of sessionActions) assert.equal((await request(sessionAction(conflict, snapshot, join(directory, "target")))).ok, false);
      assert.equal((await request({ type: "open_session", cwd: snapshot.session.cwd, sessionPath: snapshot.session.path })).ok, false);
      disposeGate.resolve();
      await runtimes[0].mutationEntered.promise;
      assert.equal((await request({ type: "open_session", cwd: snapshot.session.cwd, sessionPath: snapshot.session.path })).ok, false);
    } finally { disposeGate.resolve(); mutationGate.resolve(); }
    assert.equal((await pending).ok, false);
    assert.equal((await request({ type: "open_session", cwd: snapshot.session.cwd, sessionPath: snapshot.session.path })).ok, true, "failure must release the path lock");
  });

  test(`${action} rejects every kind of busy runtime without writing or stopping it`, async (t) => {
    for (const state of ["running", "command", "memory", "subagent", "mcp"] as const) {
      await t.test(state, async (subtest) => {
        const { directory, server, runtimes, create, request } = fixture(subtest);
        const snapshot = (await create("source")).result as SessionSnapshot;
        const gate = deferred();
        let ongoing: Promise<unknown> | undefined;
        if (state === "running") runtimes[1].setRunning(true);
        if (state === "memory") runtimes[1].emitMemoryRunning();
        if (state === "subagent") runtimes[1].emitSubagentRunning();
        if (state === "command" || state === "mcp") runtimes[1].commandGates.push(gate);
        if (state === "command") ongoing = request({ type: "set_session_fast", enabled: true }, snapshot.runtimeId);
        if (state === "mcp") ongoing = server.accessMcp({ action: "list", cwd: snapshot.session.cwd, runtimeId: snapshot.runtimeId });
        try {
          const response = await request(sessionAction(action, snapshot, join(directory, "target")));
          assert.equal(response.ok, false, `${state} work must prevent ${action}`);
          assert.deepEqual(runtimes[0].mutations, []);
          assert.equal(runtimes[1].disposeCalls, 0);
        } finally { gate.resolve(); await ongoing; }
      });
    }
  });
}

test("session metadata mutations and workspace deletion exclude each other in both arrival orders", async (t) => {
  const { directory, runtimes, create, request } = fixture(t);
  const snapshot = (await create("source")).result as SessionSnapshot;
  const input = { cwd: snapshot.session.cwd, sessionPath: snapshot.session.path };
  const metadata: RuntimeCommand[] = [
    { type: "restore_session", ...input }, { type: "rename_session", ...input, name: "renamed" },
    { type: "pin_session", ...input, pinned: true }, { type: "fork_session", ...input },
  ];
  const deleting = { type: "delete_workspace_sessions" as const, cwd: snapshot.session.cwd };
  const gate = deferred();
  runtimes[0].mutationGate = gate;
  const restoring = request(metadata[0]);
  await runtimes[0].mutationEntered.promise;
  try {
    assert.equal((await request(deleting)).ok, false, "metadata awaiting I/O must not write indexes after workspace deletion");
    assert.deepEqual(runtimes[0].deletedWorkspaces, []);
  } finally { gate.resolve(); await restoring; }
  const deleteGate = deferred();
  runtimes[0].deleteGate = deleteGate;
  const pendingDelete = request(deleting);
  await runtimes[0].deleteEntered.promise;
  try {
    for (const command of metadata) assert.equal((await request(command)).ok, false, `${command.type} must respect workspace deletion`);
    assert.deepEqual(runtimes[0].mutations, ["restore"]);
    assert.equal((await create("other")).ok, true);
  } finally { deleteGate.resolve(); await pendingDelete; }
  assert.equal((await request({ type: "restore_session", cwd: join(directory, "unrelated"), sessionPath: join(directory, "unrelated.jsonl") })).ok, true);
});

for (const event of ["message_steering", "message_rejected"] as const) {
  test(`reopening a running session after ${event} keeps its runtime and returns the latest revision`, async (t) => {
    const { create, request, runtimes } = fixture(t);
    const a = (await create("a")).result as SessionSnapshot;
    runtimes[1].setRunning(true);
    runtimes[1].snapshotValue = { ...runtimes[1].snapshotValue!, messageRevision: 2, messages: [
      { id: "assistant", order: 1, role: "assistant", text: "ab", timestamp: 1, status: "running" },
    ] };
    const reopen = { type: "open_session" as const, cwd: a.session.cwd, sessionPath: a.session.path };
    // A prior snapshot clears server dirtiness while the long-running tool has
    // no new text deltas. Steering/rejection must invalidate it on their own.
    if (event === "message_rejected") await request({ type: "steer", text: "correction", clientMessageId: "interjection" }, a.runtimeId);
    const before = (await request(reopen)).result as SessionSnapshot;
    await create("b");
    if (event === "message_steering") await request({ type: "steer", text: "correction", clientMessageId: "interjection" }, a.runtimeId);
    else runtimes[1].rejectSteering("interjection");
    const after = (await request(reopen)).result as SessionSnapshot;
    assert.equal(after.runtimeId, a.runtimeId, "returning to a background session must reuse its live runtime");
    assert.equal(after.running, true);
    assert.equal(after.messageRevision, before.messageRevision! + 1);
    assert.equal(after.messages[0].text, "ab");
    assert.deepEqual(after.steering?.map((item) => item.id), event === "message_steering" ? ["interjection"] : []);
  });
}
