import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import terminalExtension from "../extensions/terminal.ts";
import { waitForTerminalExit } from "../extensions/terminal/wait.ts";
import type { ManagedTerminal } from "../extensions/terminal/types.ts";

function harness(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "coil-terminal-races-"));
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
  terminalExtension({ registerTool: (tool: any) => tools.set(tool.name, tool),
    events: {
      on(channel: string, listener: (value: unknown) => void) {
        let listeners = eventHandlers.get(channel);
        if (!listeners) eventHandlers.set(channel, listeners = new Set());
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      emit(channel: string, value: unknown) {
        for (const listener of [...eventHandlers.get(channel) ?? []]) listener(value);
      },
    },
    on: (name: string, handler: any) => handlers.set(name, handler), sendMessage() {}, appendEntry() {} } as any);
  const shutdown = () => handlers.get("session_shutdown")!({}, { cwd: root });
  t.after(async () => {
    await shutdown();
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, shutdown, emit: (name: string, event: object) => handlers.get(name)!({ type: name, ...event }, { cwd: root }),
    run: (tool: string, params: object, signal?: AbortSignal) =>
    tools.get(tool).execute("race-call", params, signal, undefined, { cwd: root }) };
}

test("exit wait observes an abort that happened before listener registration", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = { status: "running", listeners: new Set() } as ManagedTerminal;
  const pending = waitForTerminalExit(session, 100, AbortSignal.abort());
  t.mock.timers.tick(100);
  assert.equal(await pending, "aborted");
  assert.equal(session.listeners.size, 0);
});

test("cancelling while the PTY loads prevents shell side effects", async (t) => {
  const h = harness(t);
  const marker = join(h.root, "should-not-exist");
  const controller = new AbortController();
  const pending = h.run("bash", { command: `printf cancelled > '${marker}'`, block_until_ms: 1000 }, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(existsSync(marker), false);
});

test("shutdown during PTY loading prevents a late process from escaping cleanup", async (t) => {
  const h = harness(t);
  const pending = h.run("bash", { command: "sleep 2", is_background: true });
  const outcome = pending.then(() => undefined, (error: unknown) => error);
  await h.shutdown();
  assert.match(String(await outcome), /closed|shutdown/i);
  assert.equal((await h.run("terminal", { action: "list" })).details.running, 0);
});

test("parallel starts cannot claim the same running terminal name", async (t) => {
  const h = harness(t);
  const outcomes = await Promise.allSettled([0, 1].map(() => h.run("bash", {
    command: "sleep 2", name: "one-owner", is_background: true,
  })));
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await h.run("terminal", { action: "list" })).details.running, 1);
});

test("stopping an activity stops its auto-background commands after continuation changes the run signal", async (t) => {
  const h = harness(t);
  await h.emit("agent_start", {});
  const originalSignal = new AbortController();
  const command = await h.run("bash", { command: "sleep 30", block_until_ms: 1 }, originalSignal.signal);
  assert.equal(command.details.popped_out_into_background, true);
  const service = await h.run("bash", { command: "sleep 30", is_background: true, name: "explicit-service" });
  // Pi can begin another underlying run after compaction without settling the activity.
  await h.emit("agent_start", {});
  await h.emit("agent_settled", { aborted: true });
  assert.equal(originalSignal.signal.aborted, false, "the old run's signal is not the owner of the continued activity");
  const listed = (await h.run("terminal", { action: "list" })).details.sessions;
  const stopped = listed.find((entry: any) => entry.id === command.details.id);
  assert.equal(stopped.status, "stopped", JSON.stringify(listed));
  assert.equal(stopped.cleanup.verified, true);
  assert.deepEqual(stopped.cleanup.residualPids, []);
  assert.equal(listed.find((entry: any) => entry.id === service.details.id).status, "running");
});
