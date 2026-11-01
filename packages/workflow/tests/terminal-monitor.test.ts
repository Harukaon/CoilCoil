import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { BackgroundWaitState } from "../extensions/background-wait.ts";
import {
  createTerminalMonitorRegistry,
  MAX_ACTIVE_MONITORS,
  MAX_COMPLETED_MONITORS,
  MAX_MONITOR_EVENTS,
  MONITOR_OUTPUT_LIMIT,
  type TerminalMonitorEvent,
} from "../extensions/terminal/monitor.ts";
import { appendOutput, createScreenState, notifyListeners } from "../extensions/terminal/output.ts";
import type { ManagedTerminal } from "../extensions/terminal/types.ts";

function terminal(id = "term-1"): ManagedTerminal {
  return {
    id, ownerToolCallId: `call-${id}`, name: id, command: "watch", cwd: process.cwd(),
    pid: 0, pty: {} as ManagedTerminal["pty"], status: "running", startedAt: Date.now(),
    stopRequested: false, background: true, outputMode: "log", outputPath: "",
    buffer: "", bufferStart: 0, outputEnd: 0, defaultCursor: 0,
    screen: createScreenState(), lastOutputAt: Date.now(), notifications: [], listeners: new Set(),
  };
}

function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: TerminalMonitorEvent[] = [];
  const waits: BackgroundWaitState[] = [];
  const registry = createTerminalMonitorRegistry({
    onEvent: (event) => events.push(event),
    onWaitingChange: (state) => waits.push(state),
  });
  t.after(() => registry.dispose());
  return { registry, events, waits, tick: (ms = 200) => t.mock.timers.tick(ms) };
}

function exit(session: ManagedTerminal, status: ManagedTerminal["status"] = "exited"): void {
  session.status = status;
  session.exitCode = status === "exited" ? 0 : 1;
  notifyListeners(session);
}

test("an exit monitor sleeps without polling and fires only when the terminal ends", (t) => {
  const { registry, events, waits, tick } = harness(t);
  const session = terminal();
  const monitor = registry.start(session, { mode: "exit", description: "build completes" });
  assert.equal(session.listeners.size, 1);
  assert.equal(registry.wait([monitor.id]).waiting, true);
  appendOutput(session, "building\n");
  tick(24 * 60 * 60_000);
  assert.equal(events.length, 0);
  assert.deepEqual(waits, [{ waiting: true, monitorIds: [monitor.id] }]);
  exit(session);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.mode, "exit");
  assert.equal(events[0]!.output, "building");
  assert.equal(registry.get(monitor.id).status, "completed");
  assert.equal(session.listeners.size, 0);
});

test("output is coalesced for 200ms and a one-shot monitor detaches after its first event", (t) => {
  const { registry, events, tick } = harness(t);
  const session = terminal();
  const monitor = registry.start(session, { mode: "output" });
  appendOutput(session, "one\n");
  tick(100);
  appendOutput(session, "two\n");
  tick(99);
  assert.equal(events.length, 0);
  tick(1);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.output, "one\ntwo");
  assert.equal(registry.get(monitor.id).status, "completed");
  appendOutput(session, "three\n");
  exit(session);
  tick();
  assert.equal(events.length, 1);
});

test("output monitors wait for a complete line and keep the following partial line for the next event", (t) => {
  const { registry, events, tick } = harness(t);
  const session = terminal();
  registry.start(session, { mode: "output", persistent: true });
  appendOutput(session, "partial");
  tick(1_000);
  assert.equal(events.length, 0);
  appendOutput(session, " line\nnext");
  tick();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.output, "partial line");
  appendOutput(session, " line\n");
  tick();
  assert.equal(events[1]!.output, "next line");
});

test("exit flushes an output monitor's last line even without a newline", (t) => {
  const { registry, events, tick } = harness(t);
  const session = terminal();
  registry.start(session, { mode: "output" });
  appendOutput(session, "final result");
  tick();
  assert.equal(events.length, 0);
  exit(session);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.mode, "exit");
  assert.equal(events[0]!.output, "final result");
});

test("literal matching spans chunks and does not re-trigger from the old match", (t) => {
  const { registry, events, tick } = harness(t);
  const session = terminal();
  registry.start(session, { mode: "match", pattern: "READY", persistent: true });
  appendOutput(session, "RE");
  tick();
  assert.equal(events.length, 0);
  appendOutput(session, "AD");
  appendOutput(session, "Y\n");
  tick();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.mode, "match");
  appendOutput(session, "unrelated\n");
  tick();
  assert.equal(events.length, 1);
  appendOutput(session, "READY again\n");
  tick();
  assert.equal(events.length, 2);
});

test("single-character patterns do not retain the old match as their tail", (t) => {
  const { registry, events, tick } = harness(t);
  const session = terminal();
  registry.start(session, { mode: "match", pattern: "x", persistent: true });
  appendOutput(session, "x");
  tick();
  appendOutput(session, "y");
  tick();
  assert.equal(events.length, 1);
  appendOutput(session, "x");
  tick();
  assert.equal(events.length, 2);
});

test("screen output preserves each committed line for output monitors", (t) => {
  const { registry, events, tick } = harness(t);
  const session = terminal();
  session.outputMode = "screen";
  registry.start(session, { mode: "output", persistent: true });
  appendOutput(session, "A\n");
  tick();
  appendOutput(session, "B\n");
  tick();
  assert.deepEqual(events.map((event) => event.output), ["A", "B"]);
});

test("screen literal matches do not concatenate separate committed lines", (t) => {
  const { registry, events, tick } = harness(t);
  const session = terminal();
  session.outputMode = "screen";
  registry.start(session, { mode: "match", pattern: "AB", persistent: true });
  appendOutput(session, "A\n");
  appendOutput(session, "B\n");
  tick();
  assert.equal(events.length, 0);
  appendOutput(session, "AB\n");
  tick();
  assert.equal(events.length, 1);
});

test("screen matches span appended frame text and do not fire again when the frame commits", (t) => {
  const { registry, events, tick } = harness(t);
  const session = terminal();
  session.outputMode = "screen";
  registry.start(session, { mode: "match", pattern: "READY", persistent: true });
  appendOutput(session, "RE");
  tick();
  assert.equal(events.length, 0);
  appendOutput(session, "ADY");
  tick();
  assert.equal(events.length, 1);
  appendOutput(session, "\n");
  tick();
  assert.equal(events.length, 1, "the committed line only adds its newline after an already-consumed frame");
});

test("rewritten screen frames clear partial literal state rather than create a false match", (t) => {
  const { registry, events, tick } = harness(t);
  const session = terminal();
  session.outputMode = "screen";
  registry.start(session, { mode: "match", pattern: "AB", persistent: true });
  appendOutput(session, "A");
  appendOutput(session, "\rB");
  tick();
  assert.equal(events.length, 0);
  appendOutput(session, "\rAB");
  tick();
  assert.equal(events.length, 1);
});

test("screen output discards an overwritten partial line before committing", (t) => {
  const { registry, events, tick } = harness(t);
  const session = terminal();
  session.outputMode = "screen";
  registry.start(session, { mode: "output", persistent: true });
  appendOutput(session, "old");
  appendOutput(session, "\rnew\n");
  tick();
  assert.deepEqual(events.map((event) => event.output), ["new"]);
});

test("a monitor starting after an existing screen frame consumes only future appended text", (t) => {
  const { registry, events, tick } = harness(t);
  const session = terminal();
  session.outputMode = "screen";
  appendOutput(session, "READY");
  registry.start(session, { mode: "match", pattern: "READY", persistent: true });
  appendOutput(session, " later");
  appendOutput(session, "\n");
  tick();
  assert.equal(events.length, 0);
  appendOutput(session, "READY now\n");
  tick();
  assert.equal(events.length, 1);
});

test("screen cursor=0 can observe a retained frame and exit flushes a final partial frame", (t) => {
  const { registry, events, tick } = harness(t);
  const session = terminal();
  session.outputMode = "screen";
  appendOutput(session, "READY");
  const first = registry.start(session, { mode: "match", pattern: "READY", cursor: 0 });
  tick();
  assert.equal(events.length, 1);
  assert.equal(registry.get(first.id).status, "completed");
  registry.start(session, { mode: "output", cursor: 0 });
  exit(session);
  assert.equal(events.length, 2);
  assert.equal(events[1]!.output, "READY");
});

test("an exit flushes a pending one-shot match once, without waiting out the coalescing timer", (t) => {
  const { registry, events, tick } = harness(t);
  const session = terminal();
  registry.start(session, { mode: "match", pattern: "DONE" });
  appendOutput(session, "DONE\n");
  exit(session);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.mode, "match");
  assert.equal(events[0]!.status, "exited");
  tick(1_000);
  assert.equal(events.length, 1);
});

test("a persistent monitor ends with one exit event carrying its unflushed output", (t) => {
  const { registry, events, tick } = harness(t);
  const session = terminal();
  const monitor = registry.start(session, { mode: "output", persistent: true });
  appendOutput(session, "first\n");
  tick();
  appendOutput(session, "last\n");
  exit(session, "failed");
  assert.equal(events.length, 2);
  assert.equal(events[1]!.mode, "exit");
  assert.equal(events[1]!.output, "last");
  assert.equal(events[1]!.status, "failed");
  assert.equal(registry.get(monitor.id).status, "completed");
  tick();
  assert.equal(events.length, 2);
});

test("exiting before a requested literal appears still reports the result", (t) => {
  const { registry, events } = harness(t);
  const session = terminal();
  registry.start(session, { mode: "match", pattern: "READY" });
  appendOutput(session, "configuration failed\n");
  exit(session, "failed");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.mode, "exit");
  assert.match(events[0]!.output, /configuration failed/);
});

test("registering an already-exited terminal captures its result immediately", (t) => {
  const { registry, events, waits } = harness(t);
  const session = terminal();
  appendOutput(session, "complete\n");
  exit(session);
  const monitor = registry.start(session, { mode: "exit" });
  assert.equal(monitor.status, "completed");
  assert.equal(events[0]!.output, "complete\n");
  const result = registry.wait([monitor.id]);
  assert.equal(result.waiting, false);
  assert.equal(result.monitors[0]!.lastEvent?.mode, "exit");
  assert.deepEqual(waits, []);
  assert.equal(session.listeners.size, 0);
});

test("default cursors ignore historical output while cursor=0 can watch output before registration", (t) => {
  const { registry, events, tick } = harness(t);
  const session = terminal();
  appendOutput(session, "READY old\n");
  const monitor = registry.start(session, { mode: "match", pattern: "READY" });
  tick();
  assert.equal(events.length, 0);
  registry.cancel(monitor.id);
  registry.start(session, { mode: "match", pattern: "READY", cursor: 0 });
  tick();
  assert.equal(events.length, 1);
});

test("capturing an event keeps the wait until actual delivery releases it", (t) => {
  const { registry, events, waits } = harness(t);
  const session = terminal();
  const monitor = registry.start(session, { mode: "exit" });
  registry.wait([monitor.id]);
  exit(session);
  assert.equal(events.length, 1);
  assert.equal(waits.length, 1);
  assert.equal(waits[0]!.waiting, true);
  registry.releaseWait([session.id]);
  assert.deepEqual(waits.at(-1), { waiting: false, monitorIds: [] });
  registry.releaseWait([session.id]);
  assert.equal(waits.length, 2, "repeated delivery acknowledgments do not publish more state changes");
});

test("a ready event returns directly from wait and a persistent monitor can be awaited again", (t) => {
  const { registry, events, waits, tick } = harness(t);
  const session = terminal();
  const monitor = registry.start(session, { mode: "output", persistent: true });
  appendOutput(session, "changed\n");
  tick();
  assert.equal(events.length, 1);
  const ready = registry.wait([monitor.id]);
  assert.equal(ready.waiting, false);
  assert.equal(ready.monitors[0]!.lastEvent?.output, "changed");
  assert.equal(waits.length, 0);
  assert.equal(registry.wait([monitor.id]).waiting, true);
  registry.releaseWait([session.id]);
  assert.equal(registry.wait([monitor.id]).waiting, true);
  assert.equal(registry.get(monitor.id).status, "watching");
});

test("one delivered event wakes a wait-any group without stopping its other monitors", (t) => {
  const { registry, waits } = harness(t);
  const a = terminal("term-a"), b = terminal("term-b");
  const first = registry.start(a, { mode: "exit" });
  const second = registry.start(b, { mode: "exit" });
  registry.wait([first.id, second.id]);
  registry.releaseWait(["unrelated"]);
  assert.equal(waits.length, 1);
  exit(a);
  registry.releaseWait([a.id]);
  assert.deepEqual(waits.at(-1), { waiting: false, monitorIds: [] });
  assert.equal(registry.get(second.id).status, "watching");
  assert.equal(b.listeners.size, 1);
});

test("acknowledging a replaced subscription cannot consume a newer synchronous result", (t) => {
  const { registry } = harness(t);
  const session = terminal();
  appendOutput(session, "DONE\n");
  exit(session);
  const old = registry.start(session, { mode: "exit" });
  const current = registry.start(session, { mode: "exit" });
  registry.acknowledge([old.id]);
  const ready = registry.wait([current.id]);
  assert.equal(ready.waiting, false);
  assert.equal(ready.monitors[0]!.lastEvent!.monitorId, current.id);
  assert.deepEqual(registry.wait().monitors, [], "the old result must not return in a later default wait");
});

test("acknowledging an old monitor does not release an active new monitor's wait", (t) => {
  const { registry, waits, tick } = harness(t);
  const session = terminal();
  const old = registry.start(session, { mode: "output" });
  appendOutput(session, "old condition\n");
  tick();
  const current = registry.start(session, { mode: "exit" });
  registry.wait([current.id]);
  registry.acknowledge([old.id]);
  assert.equal(waits.length, 1);
  assert.equal(waits[0]!.waiting, true);
  exit(session);
  registry.acknowledge([current.id]);
  assert.deepEqual(waits.at(-1), { waiting: false, monitorIds: [] });
});

test("acknowledgment releases a wait-any group and tolerates pruned IDs", (t) => {
  const { registry, waits } = harness(t);
  const first = registry.start(terminal("first"), { mode: "exit" });
  const second = registry.start(terminal("second"), { mode: "exit" });
  registry.wait([first.id, second.id]);
  registry.acknowledge([first.id, "already-pruned"]);
  assert.deepEqual(waits.at(-1), { waiting: false, monitorIds: [] });
  registry.acknowledge([first.id, "already-pruned"]);
  assert.equal(waits.length, 2);
});

test("invalid wait IDs do not disturb an already-armed wait", (t) => {
  const { registry, waits } = harness(t);
  const monitor = registry.start(terminal(), { mode: "exit" });
  registry.wait([monitor.id]);
  assert.throws(() => registry.wait([monitor.id, "missing"]), /Monitor not found/);
  assert.equal(waits.length, 1);
  registry.cancel(monitor.id);
  assert.deepEqual(waits.at(-1), { waiting: false, monitorIds: [] });
});

test("cancel detaches the watcher, clears pending output and prevents a later wake", (t) => {
  const { registry, events, waits, tick } = harness(t);
  const session = terminal();
  const monitor = registry.start(session, { mode: "output" });
  registry.wait([monitor.id]);
  appendOutput(session, "queued\n");
  assert.equal(registry.cancel(monitor.id).status, "stopped");
  assert.equal(session.listeners.size, 0);
  assert.equal(waits.at(-1)!.waiting, false);
  tick();
  appendOutput(session, "late\n");
  exit(session);
  assert.equal(events.length, 0);
});

test("cancelAll publishes one transition and does not stop the owned processes", (t) => {
  const { registry, events, waits, tick } = harness(t);
  const a = terminal("term-a"), b = terminal("term-b");
  registry.start(a, { mode: "output" });
  registry.start(b, { mode: "exit" });
  registry.wait();
  appendOutput(a, "queued\n");
  registry.cancelAll();
  assert.equal(waits.length, 2);
  assert.equal(registry.list().every((monitor) => monitor.status === "stopped"), true);
  assert.equal(a.status, "running");
  assert.equal(b.status, "running");
  assert.equal(a.listeners.size + b.listeners.size, 0);
  tick();
  assert.equal(events.length, 0);
});

test("dispose detaches all listeners and timers without sending further state or events", (t) => {
  const { registry, events, waits, tick } = harness(t);
  const session = terminal();
  registry.start(session, { mode: "output" });
  registry.wait();
  appendOutput(session, "pending\n");
  registry.dispose();
  assert.equal(session.listeners.size, 0);
  tick();
  exit(session);
  assert.equal(events.length, 0);
  assert.equal(waits.length, 1);
  assert.equal(registry.list().length, 0);
  assert.throws(() => registry.start(session, { mode: "exit" }), /closed/);
});

test("duplicate and malformed monitor requests leave no extra listener behind", (t) => {
  const { registry } = harness(t);
  const session = terminal();
  const monitor = registry.start(session, { mode: "exit" });
  assert.throws(() => registry.start(session, { mode: "output" }), /already has monitor/);
  assert.equal(session.listeners.size, 1);
  registry.cancel(monitor.id);
  for (const config of [
    { mode: "match" as const },
    { mode: "match" as const, pattern: " " },
    { mode: "output" as const, pattern: "x" },
    { mode: "match" as const, pattern: "x".repeat(501) },
    { mode: "exit" as const, cursor: -1 },
    { mode: "exit" as const, cursor: 1 },
  ]) assert.throws(() => registry.start(session, config));
  assert.equal(session.listeners.size, 0);
});

test("active and completed monitor retention stay bounded", (t) => {
  const { registry } = harness(t);
  for (let index = 0; index < MAX_ACTIVE_MONITORS; index++) registry.start(terminal(`active-${index}`), { mode: "exit" });
  assert.throws(() => registry.start(terminal("overflow"), { mode: "exit" }), /At most/);
  registry.cancelAll();
  for (let index = 0; index < MAX_COMPLETED_MONITORS + 5; index++) {
    const session = terminal(`done-${index}`);
    exit(session);
    registry.start(session, { mode: "exit" });
  }
  assert.equal(registry.list().length, MAX_COMPLETED_MONITORS);
});

test("a captured result that still owns a wait is retained until release", (t) => {
  const { registry } = harness(t);
  const session = terminal("held");
  const held = registry.start(session, { mode: "exit" });
  registry.wait([held.id]);
  exit(session);
  for (let index = 0; index < MAX_COMPLETED_MONITORS + 1; index++) {
    const done = terminal(`done-${index}`);
    exit(done);
    registry.start(done, { mode: "exit" });
  }
  assert.equal(registry.get(held.id).status, "completed");
  assert.equal(registry.list().length, MAX_COMPLETED_MONITORS);
  registry.releaseWait([session.id]);
});

test("monitor snapshots cannot mutate the registry or its last event", (t) => {
  const { registry } = harness(t);
  const session = terminal();
  const started = registry.start(session, { mode: "exit" });
  started.status = "stopped";
  assert.equal(registry.get(started.id).status, "watching");
  exit(session);
  const done = registry.get(started.id);
  done.lastEvent!.output = "tampered";
  assert.notEqual(registry.get(started.id).lastEvent!.output, "tampered");
});

test("monitor event text is bounded even for a very large burst", (t) => {
  const { registry, events, tick } = harness(t);
  const session = terminal();
  registry.start(session, { mode: "output" });
  appendOutput(session, "x".repeat(MONITOR_OUTPUT_LIMIT * 3) + "\n");
  tick();
  assert.equal(events[0]!.output.length, MONITOR_OUTPUT_LIMIT - 1);
});

test("a noisy persistent monitor sends a final stop notice and detaches at its event budget", (t) => {
  const { registry, events, tick } = harness(t);
  const session = terminal();
  const monitor = registry.start(session, { mode: "output", persistent: true });
  for (let index = 0; index < MAX_MONITOR_EVENTS; index++) {
    appendOutput(session, `change ${index}\n`);
    tick();
  }
  assert.equal(events.length, MAX_MONITOR_EVENTS);
  assert.match(events.at(-1)!.reason, /事件过多.*监控已停止/);
  assert.equal(registry.get(monitor.id).status, "stopped");
  assert.equal(session.listeners.size, 0);
  appendOutput(session, "later\n");
  exit(session);
  tick();
  assert.equal(events.length, MAX_MONITOR_EVENTS);
});

test("one enormous unterminated line stays bounded and is flushed only at exit", (t) => {
  const { registry, events, tick } = harness(t);
  const session = terminal();
  registry.start(session, { mode: "output" });
  appendOutput(session, "x".repeat(MONITOR_OUTPUT_LIMIT * 20));
  tick(1_000);
  assert.equal(events.length, 0);
  exit(session);
  assert.equal(events[0]!.output.length, MONITOR_OUTPUT_LIMIT);
});
