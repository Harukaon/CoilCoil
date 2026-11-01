import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import * as pty from "node-pty";
import terminalExtension from "../extensions/terminal.ts";
import goalExtension from "../extensions/goal.ts";
import {
  BACKGROUND_WAIT_CANCEL_CHANNEL,
  BACKGROUND_WAIT_STATE_CHANNEL,
  type BackgroundWaitCancelRequest,
} from "../extensions/background-wait.ts";
import { parseProcessTable, scanTerminalProcesses, stopTerminal } from "../extensions/terminal/process-cleanup.ts";
import type { ManagedTerminal, ProcessRecord } from "../extensions/terminal/types.ts";
import { createTerminalMonitorRegistry, MAX_ACTIVE_MONITORS } from "../extensions/terminal/monitor.ts";
import { registerTerminalMonitorTool } from "../extensions/terminal/monitor-tool.ts";
import { createNoticeDispatcher } from "../extensions/terminal/notify.ts";
import { createScreenState, notifyListeners } from "../extensions/terminal/output.ts";

const unix = { skip: process.platform === "win32" };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean | Promise<boolean>, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(10);
  }
  assert.ok(await condition(), message);
}

async function harness(t: TestContext, withGoal = false) {
  const cwd = await mkdtemp(join(tmpdir(), "coil-monitor-integration-"));
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const channels = new Map<string, Set<(value: any) => void>>();
  const messages: Array<{ message: any; options: any }> = [];
  const userMessages: string[] = [];
  const entries: Array<{ customType: string; data: any }> = [];
  const transitions: Array<{ channel: string; value: any }> = [];
  let running = false;
  let shutDown = false;
  const ctx = {
    cwd,
    ui: { notify() {} },
    hasUI: false,
    isIdle: () => !running,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => entries.map((entry) => ({ type: "custom", ...entry })) },
  };
  const pi = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    getActiveTools() { return [...tools.keys()]; },
    setActiveTools() {},
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, [...handlers.get(name) ?? [], handler]);
    },
    sendMessage(message: any, options: any) { messages.push({ message, options }); },
    sendUserMessage(message: string) { userMessages.push(message); },
    appendEntry(customType: string, data: any) { entries.push({ customType, data }); },
    events: {
      on(channel: string, listener: (value: any) => void) {
        let listeners = channels.get(channel);
        if (!listeners) channels.set(channel, listeners = new Set());
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      emit(channel: string, value: any) {
        transitions.push({ channel, value });
        for (const listener of [...channels.get(channel) ?? []]) listener(value);
      },
    },
  };
  if (withGoal) goalExtension(pi as never);
  terminalExtension(pi as never);
  const emit = async (name: string, event: object = {}) => {
    if (name === "agent_start") running = true;
    if (name === "agent_settled") running = false;
    for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
  };
  const run = (name: string, params: Record<string, unknown>, signal?: AbortSignal) =>
    tools.get(name).execute(`integration-${name}`, params, signal, undefined, ctx);
  const cancel = () => {
    const request: BackgroundWaitCancelRequest = {};
    pi.events.emit(BACKGROUND_WAIT_CANCEL_CHANNEL, request);
    return request;
  };
  const shutdown = async () => {
    if (shutDown) return;
    shutDown = true;
    await emit("session_shutdown");
  };
  t.after(async () => {
    await shutdown();
    await rm(cwd, { recursive: true, force: true });
  });
  const listTerminals = async () => (await run("terminal", { action: "list" })).details.sessions as any[];
  const restartFromNotice = async () => {
    await emit("before_agent_start");
    await emit("agent_start");
    await emit("agent_settled", { aborted: false });
  };
  return { cwd, ctx, run, emit, cancel, shutdown, listTerminals, restartFromNotice,
    messages, userMessages, entries, transitions, commands };
}

test("terminal await ignores a 900000ms legacy timeout, suspends immediately and wakes exactly once", unix, async (t) => {
  const h = await harness(t);
  await h.emit("agent_start");
  const started = await h.run("bash", { command: "sleep 0.4; printf 'DONE\\n'", is_background: true });
  const startedAt = performance.now();
  const result = await h.run("terminal", { action: "await", id: started.details.id, timeoutMs: 900_000 });
  assert.ok(performance.now() - startedAt < 500, "await returns without waiting for the subprocess");
  assert.equal(result.terminate, true);
  assert.equal(result.details.waiting, true);
  assert.equal(h.messages.length, 0);
  await h.emit("agent_settled", { aborted: false });
  await until(() => h.messages.length > 0, "background completion wakes the settled agent");
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0]!.options.triggerTurn, true);
  assert.equal(h.messages[0]!.options.deliverAs, "followUp");
  assert.match(h.messages[0]!.message.content, /DONE/);
  assert.equal(h.transitions.filter((entry) => entry.channel === BACKGROUND_WAIT_STATE_CHANNEL).at(-1)!.value.waiting, false);
  await sleep(250);
  assert.equal(h.messages.length, 1, "automatic terminal exit and monitor exit share one notification owner");
});

test("readiness wakes the agent and cancelling an attached subscription leaves its service alive", unix, async (t) => {
  const h = await harness(t);
  const service = await h.run("bash", {
    command: "sleep 0.35; printf RE; sleep 0.05; printf 'ADY\\n'; sleep 10",
    is_background: true,
  });
  const ready = await h.run("monitor", { terminalId: service.details.id, event: "match", waitFor: "READY" });
  assert.equal(ready.terminate, true);
  await until(() => h.messages.length > 0, "literal readiness event arrives across PTY chunks");
  assert.match(h.messages[0]!.message.content, /READY/);
  assert.equal((await h.listTerminals()).find((terminal) => terminal.id === service.details.id)!.status, "running");
  await h.restartFromNotice();
  const watching = await h.run("monitor", { terminalId: service.details.id, event: "exit", suspend: false });
  await h.run("monitor", { action: "stop", id: watching.details.monitor_id });
  assert.equal((await h.listTerminals()).find((terminal) => terminal.id === service.details.id)!.status, "running");
  await h.run("terminal", { action: "stop", id: service.details.id, timeoutMs: 1_000 });
  await sleep(250);
  assert.equal(h.messages.length, 1, "stopping a cancelled subscription does not enqueue an exit wake-up");
});

test("command monitors isolate stderr and deliver complete stdout lines in multiple coalesced events", unix, async (t) => {
  const h = await harness(t);
  const result = await h.run("monitor", {
    command: "printf 'STDERR_ONLY\\n' >&2; sleep 0.4; printf FIRST; sleep 0.05; printf ' LINE\\nSECOND LINE\\n'; sleep 0.8; printf THIRD; sleep 0.4; printf ' LINE\\n'; sleep 10",
    description: "stream meaningful changes", suspend: false,
  });
  assert.equal(typeof result.details.stderr_location, "string");
  await until(async () => (await readFile(result.details.stderr_location, "utf8")).includes("STDERR_ONLY"), "stderr is captured independently");
  await sleep(200);
  assert.equal(h.messages.length, 0, "stderr alone is not a monitor event");
  await until(() => h.messages.length > 0, "first stdout lines are delivered");
  assert.match(h.messages[0]!.message.content, /FIRST LINE\nSECOND LINE/);
  assert.doesNotMatch(h.messages[0]!.message.content, /STDERR_ONLY/);
  await h.restartFromNotice();
  await until(async () => (await readFile(result.details.output_location, "utf8")).includes("THIRD"), "partial stdout arrives");
  assert.equal(h.messages.length, 1, "an incomplete next line does not wake the agent");
  await until(() => h.messages.length > 1, "the next completed line creates a later event");
  assert.match(h.messages[1]!.message.content, /THIRD LINE/);
  await h.run("monitor", { action: "stop", id: result.details.monitor_id });
  await sleep(250);
  assert.equal(h.messages.length, 2, "owned watcher cancellation does not add an exit notification");
});

test("an existing default-screen terminal emits separate committed lines to a recurring monitor", unix, async (t) => {
  const h = await harness(t);
  const terminal = await h.run("terminal", {
    action: "start", command: "sleep 0.25; printf 'SCREEN_A\\n'; sleep 0.4; printf 'SCREEN_B\\n'; sleep 10",
  });
  assert.equal(terminal.details.outputMode, "screen");
  const monitor = await h.run("monitor", { terminalId: terminal.details.id, event: "output", repeat: true, suspend: false });
  await until(() => h.messages.length > 0, "first committed screen line triggers its event");
  assert.match(h.messages[0]!.message.content, /SCREEN_A/);
  await h.restartFromNotice();
  await until(() => h.messages.length > 1, "second committed screen line triggers a later event");
  assert.match(h.messages[1]!.message.content, /SCREEN_B/);
  await h.run("monitor", { action: "stop", id: monitor.details.monitor_id });
  await h.run("terminal", { action: "stop", id: terminal.details.id, timeoutMs: 1_000 });
  await sleep(250);
  assert.equal(h.messages.length, 2);
});

test("the cancellation channel synchronously revokes idle waits and cleans owned watchers without late notifications", unix, async (t) => {
  const h = await harness(t, true);
  await h.emit("session_start");
  await h.commands.get("goal").handler("complete after an external result", h.ctx);
  await h.emit("agent_start");
  const monitor = await h.run("monitor", { command: "sleep 10; printf 'LATE\\n'", event: "output" });
  assert.equal(monitor.terminate, true);
  await h.emit("agent_settled", { aborted: false });
  const request = h.cancel();
  assert.equal(request.cancelled, true);
  assert.ok(request.completion instanceof Promise);
  assert.equal(h.transitions.filter((entry) => entry.channel === BACKGROUND_WAIT_STATE_CHANNEL).at(-1)!.value.waiting, false,
    "the UI wait is revoked before asynchronous process cleanup finishes");
  await request.completion;
  assert.equal((await h.listTerminals()).find((terminal) => terminal.id === monitor.details.id)!.status, "stopped");
  await sleep(1_700);
  assert.equal(h.messages.length, 0);
  assert.equal(h.userMessages.length, 1, "idle Goal must not create a second model round after a cancelled wait");
});

test("a result available before await returns directly without a duplicate wake-up", unix, async (t) => {
  const h = await harness(t);
  await h.emit("agent_start");
  const started = await h.run("bash", { command: "printf 'ALREADY_DONE\\n'", is_background: true });
  await until(() => h.entries.some((entry) => entry.customType === "coilcoil-terminal-run"
    && entry.data.id === started.details.id && entry.data.status === "succeeded"), "short command completes");
  const result = await h.run("terminal", { action: "await", id: started.details.id, timeoutMs: 900_000 });
  assert.equal(result.terminate, false);
  assert.equal(result.details.waiting, false);
  assert.match(result.details.monitors[0].lastEvent.output, /ALREADY_DONE/);
  await h.emit("agent_settled", { aborted: false });
  await sleep(300);
  assert.equal(h.messages.length, 0);
});

test("failed monitor registration preserves the terminal's automatic exit notification", unix, async (t) => {
  const h = await harness(t);
  const started = await h.run("bash", { command: "sleep 0.3; printf 'EXIT_STILL_NOTIFIES\\n'", is_background: true });
  await assert.rejects(h.run("terminal", { action: "await", id: started.details.id, cursor: 1_000_000 }), /cursor/i);
  assert.equal((await h.run("monitor", { action: "list" })).details.monitors.length, 0);
  await until(() => h.messages.length > 0, "failed monitor setup must leave the previous exit subscription alive");
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0]!.message.content, /EXIT_STILL_NOTIFIES/);
});

test("a ready monitor result includes all held incremental events without a duplicate wake-up", unix, async (t) => {
  const h = await harness(t);
  await h.emit("agent_start");
  const monitor = await h.run("monitor", {
    command: "printf 'FIRST_EVENT\\n'; sleep 0.35; printf 'SECOND_EVENT\\n'; sleep 10", suspend: false,
  });
  await until(async () => {
    try { return (await readFile(monitor.details.output_location, "utf8")).includes("SECOND_EVENT"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }, "both watcher changes arrive");
  await sleep(230);
  assert.equal(h.messages.length, 0, "the busy agent holds monitor notifications");
  const ready = await h.run("monitor", { action: "wait", id: monitor.details.monitor_id });
  assert.equal(ready.terminate, false);
  const held = ready.details.events.map((event: any) => event.output).join("\n");
  assert.match(held, /FIRST_EVENT/);
  assert.match(held, /SECOND_EVENT/);
  await h.run("monitor", { action: "stop", id: monitor.details.monitor_id });
  await h.emit("agent_settled", { aborted: false });
  await sleep(250);
  assert.equal(h.messages.length, 0);
});

test("hitting the active monitor cap does not remove a pre-existing terminal notification", (t) => {
  const makeSession = (id: string): ManagedTerminal => ({
    id, ownerToolCallId: "cap-fixture", name: id, command: "watch", cwd: tmpdir(), pid: 0,
    pty: {} as ManagedTerminal["pty"], status: "running", startedAt: Date.now(), stopRequested: false,
    background: true, outputMode: "log", outputPath: "", buffer: "", bufferStart: 0, outputEnd: 0,
    defaultCursor: 0, screen: createScreenState(), lastOutputAt: Date.now(), notifications: [], listeners: new Set(),
  });
  const sent: string[] = [];
  const notices = createNoticeDispatcher({ send: (payload) => sent.push(payload.content) });
  const registry = createTerminalMonitorRegistry({ onEvent: (event) => notices.enqueue(event), onWaitingChange() {} });
  t.after(() => { registry.dispose(); notices.dispose(); });
  for (let index = 0; index < MAX_ACTIVE_MONITORS; index++) registry.start(makeSession(`held-${index}`), { mode: "exit" });
  const target = makeSession("unmonitored");
  target.notifications = [{ mode: "exit", cursor: 0, fired: false }];
  target.notifyEvent = (event) => notices.enqueue({
    terminalId: target.id, mode: event.mode, status: target.status, output: "ORIGINAL_EXIT", reason: "original exit", at: Date.now(),
  });
  const tool = registerTerminalMonitorTool({ registerTool() {} } as never, {
    monitors: registry, notices, ownedMonitorTerminals: new Set(), isActive: () => true,
    findSession: () => target, getSession: () => target, publishTerminalState() {},
    startManagedSession: async () => { throw new Error("no process may spawn in this cap regression"); },
  });
  assert.throws(() => tool.monitorTerminal(target, { mode: "exit" }), /At most/);
  assert.equal(target.notifications.length, 1);
  target.status = "exited";
  notifyListeners(target);
  notices.flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /ORIGINAL_EXIT/);
});

test("replacing a subscription acknowledges only the old result and retains the new synchronous result", (t) => {
  const session: ManagedTerminal = {
    id: "same-terminal", ownerToolCallId: "replacement-fixture", name: "same-terminal", command: "done", cwd: tmpdir(), pid: 0,
    pty: {} as ManagedTerminal["pty"], status: "exited", startedAt: Date.now(), stopRequested: false,
    background: true, outputMode: "log", outputPath: "", buffer: "DONE\n", bufferStart: 0, outputEnd: 5,
    defaultCursor: 0, screen: createScreenState(), lastOutputAt: Date.now(), notifications: [], listeners: new Set(),
  };
  const sent: unknown[] = [];
  const notices = createNoticeDispatcher({ send: (payload) => sent.push(payload) });
  const registry = createTerminalMonitorRegistry({ onEvent: (event) => notices.enqueue(event), onWaitingChange() {} });
  t.after(() => { registry.dispose(); notices.dispose(); });
  const { monitorTerminal, waitForMonitors } = registerTerminalMonitorTool({ registerTool() {} } as never, {
    monitors: registry, notices, ownedMonitorTerminals: new Set(), isActive: () => true,
    findSession: () => session, getSession: () => session, publishTerminalState() {},
    startManagedSession: async () => { throw new Error("no process starts in this notification regression"); },
  });
  const old = monitorTerminal(session, { mode: "exit" });
  const replacement = monitorTerminal(session, { mode: "exit" });
  const result = waitForMonitors([replacement.id]);
  const details = result.details as { waiting: boolean; events: Array<{ monitorId: string }> };
  assert.equal(details.waiting, false);
  assert.deepEqual(details.events.map((event) => event.monitorId), [replacement.id], "the newly captured result remains available");
  assert.deepEqual((waitForMonitors().details as { monitors: unknown[] }).monitors, [], `${old.id} must not be re-delivered by a later default wait`);
  notices.flush();
  assert.equal(sent.length, 0);
});

test("stop during native PTY loading rejects a watcher before shell side effects", unix, async (t) => {
  const h = await harness(t);
  const marker = join(h.cwd, "should-not-start");
  const pending = h.run("monitor", { command: `printf bad > '${marker}'; sleep 10` });
  const rejected = assert.rejects(pending, /cancelled/i);
  const cancellation = h.cancel();
  await cancellation.completion;
  await rejected;
  assert.equal((await h.listTerminals()).length, 0);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("stop after spawn but before monitor registration does not install a late wake-up", unix, async (t) => {
  for (const depth of [3, 4]) {
    const h = await harness(t);
    await h.run("bash", { command: "true", block_until_ms: 1_000 });
    const pending = h.run("monitor", { command: "sleep 10", description: "cancel during registration" });
    const rejected = assert.rejects(pending, /cancelled/i);
    const cancelling = (async () => {
      for (let index = 0; index < depth; index++) await Promise.resolve();
      const request = h.cancel();
      assert.equal(request.cancelled, true, "the watcher was spawned and belongs to cancellation before its subscription commits");
      await request.completion;
    })();
    await cancelling;
    await rejected;
    assert.equal((await h.run("monitor", { action: "list" })).details.monitors.length, 0);
    assert.equal((await h.listTerminals()).some((terminal) => terminal.status === "running"), false);
    await sleep(200);
    assert.equal(h.messages.length, 0, `depth ${depth}: a cancelled watcher must not install a completion subscription`);
  }
});

test("monitor notifications and cancellation stay inside their owning session", unix, async (t) => {
  const first = await harness(t);
  const second = await harness(t);
  const a = await first.run("monitor", { command: "sleep 10", description: "first session watcher" });
  const b = await second.run("monitor", { command: "sleep 0.25; printf 'SECOND_ONLY\\n'; sleep 10", suspend: false });
  assert.equal(a.details.monitor_id, b.details.monitor_id, "IDs may repeat between isolated sessions");
  const cancellation = first.cancel();
  await cancellation.completion;
  await until(() => second.messages.length > 0, "second session independently receives its event");
  assert.equal(first.messages.length, 0);
  assert.match(second.messages[0]!.message.content, /SECOND_ONLY/);
  assert.equal((await second.listTerminals()).find((terminal) => terminal.id === b.details.id)!.status, "running");
  await second.shutdown();
  assert.equal((await second.listTerminals()).some((terminal) => terminal.status === "running"), false);
  await sleep(250);
  assert.equal(second.messages.length, 1, "shutdown detaches monitors before killing their processes");
});

test("shutdown cancels an active wait and does not emit a completion wake-up", unix, async (t) => {
  const h = await harness(t);
  const result = await h.run("monitor", { command: "sleep 10; printf 'AFTER_SHUTDOWN\\n'" });
  assert.equal(result.terminate, true);
  await h.shutdown();
  const terminal = (await h.listTerminals()).find((entry) => entry.id === result.details.id)!;
  assert.equal(terminal.status, "stopped");
  assert.equal(terminal.cleanup.verified, true);
  await sleep(250);
  assert.equal(h.messages.length, 0);
  await assert.rejects(h.run("monitor", { command: "printf bad" }), /closed/);
});

test("Stop refreshes a shared startup scan before interrupting a shell with a newly-created process group", unix, async (t) => {
  const child = pty.spawn("/bin/bash", ["-lc", "set -m; sleep 300 & child=$!; echo CHILD_PID=$child READY; wait"], {
    name: "xterm", cols: 100, rows: 25, cwd: tmpdir(), env: process.env,
  });
  const session: ManagedTerminal = {
    id: "startup-scan-race", name: "startup-scan-race", ownerToolCallId: "regression", command: "set -m; sleep 300 & wait",
    cwd: tmpdir(), pid: child.pid, pty: child, status: "running", startedAt: Date.now(), stopRequested: false,
    background: true, outputMode: "log", outputPath: "", buffer: "", bufferStart: 0, outputEnd: 0, defaultCursor: 0,
    screen: { line: "", cursor: 0, ansiRemainder: "", revision: 0, events: [] },
    lastOutputAt: Date.now(), notifications: [], listeners: new Set(),
  };
  const dataSubscription = child.onData((data) => { session.buffer += data; session.outputEnd = session.buffer.length; });
  const exited = new Promise<void>((resolve) => child.onExit(({ exitCode, signal }) => {
    session.exitCode = exitCode;
    session.signal = signal;
    session.endedAt = Date.now();
    session.status = session.stopRequested ? "stopped" : "exited";
    for (const listener of session.listeners) listener();
    resolve();
  }));
  const processRecord = (pid: number): ProcessRecord | undefined => {
    try {
      return parseProcessTable(execFileSync("/bin/ps", ["-p", String(pid), "-o", "pid=,ppid=,pgid=,stat=,tty=,lstart="], {
        encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      })).get(pid);
    } catch { return undefined; }
  };
  let descendant: ProcessRecord | undefined;
  t.after(async () => {
    dataSubscription.dispose();
    if (session.endedAt === undefined) child.kill("SIGKILL");
    if (descendant) {
      const current = processRecord(descendant.pid);
      if (current && current.birth === descendant.birth && current.pgid === descendant.pgid) {
        const rechecked = processRecord(descendant.pid);
        if (rechecked && rechecked.birth === descendant.birth && rechecked.pgid === descendant.pgid) {
          process.kill(descendant.pid, "SIGKILL");
        }
      }
    }
    await exited;
  });
  await until(() => session.buffer.includes("READY"), "the background child is created");
  const childPid = Number(session.buffer.match(/CHILD_PID=(\d+)/)![1]);
  descendant = processRecord(childPid);
  assert.ok(descendant);
  const actual = await scanTerminalProcesses(session, new Set());
  const root = actual.table.get(session.pid)!;
  assert.ok(actual.rootAlive && root);
  // Discovery began before the child existed, but Stop arrived while the old
  // observation was still in flight. Reusing it must not kill the parent first.
  session.processDescendants = new Map();
  session.processScanPromise = Promise.resolve({
    table: new Map([[session.pid, root]]), owned: [], rootAlive: true, unverifiedPids: [],
  }).finally(() => { session.processScanPromise = undefined; });
  const report = await stopTerminal(session, false, 1_000);
  assert.equal(processRecord(childPid), undefined, "a child in its own process group must not be orphaned by a stale startup scan");
  assert.ok(report.targetedPids.includes(childPid));
  assert.equal(report.verified, true);
  assert.deepEqual(report.residualPids, []);
});
