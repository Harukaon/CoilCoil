import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as nextTask } from "node:timers/promises";
import { createEventBus, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { BACKGROUND_WAIT_STATE_CHANNEL, BACKGROUND_WAKE_FAILURE_CHANNEL } from "../extensions/background-wait.ts";
import { createChildRunDriver } from "../extensions/subagents/child-run.ts";
import { createChildSession } from "../extensions/subagents/child.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function driverHarness(t: test.TestContext) {
  const events = createEventBus();
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const initial = deferred();
  let streaming = false;
  const emit = (event: AgentSessionEvent) => {
    if (event.type === "agent_start") streaming = true;
    if (event.type === "agent_settled") streaming = false;
    for (const listener of listeners) listener(event);
  };
  const session = {
    get isStreaming() { return streaming; },
    subscribe(listener: (event: AgentSessionEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async prompt() { emit({ type: "agent_start" }); await initial.promise; },
    async abort() { emit({ type: "agent_settled", aborted: true }); },
  } as unknown as AgentSession;
  const driver = createChildRunDriver(session, events);
  t.after(() => driver.dispose());
  const waiting = (value: boolean) => events.emit(BACKGROUND_WAIT_STATE_CHANNEL, { waiting: value, monitorIds: value ? ["m1"] : [] });
  const suspend = (toolName = "monitor") => {
    waiting(true);
    emit({ type: "tool_execution_end", toolName, toolCallId: "watch", isError: false,
      result: { content: [], details: { waiting: true }, terminate: true } });
  };
  const settle = () => emit({ type: "agent_settled", aborted: false });
  return { driver, emit, waiting, suspend, settle, initial, events, listeners };
}

test("a child waits past wait release until the actual resumed run settles", async (t) => {
  const h = driverHarness(t);
  let completed = false;
  const prompt = h.driver.prompt("watch").then(() => { completed = true; });
  h.suspend(); h.settle(); h.initial.resolve();
  await nextTask();
  assert.equal(completed, false);
  h.waiting(false);
  await nextTask();
  assert.equal(completed, false, "wait release happens before wake-up, not after the resumed work");
  h.emit({ type: "agent_start" });
  await nextTask();
  assert.equal(completed, false);
  h.settle();
  await prompt;
});

test("a complete wake-up before the initial prompt returns is not lost", async (t) => {
  const h = driverHarness(t);
  let completed = false;
  const prompt = h.driver.prompt("watch").then(() => { completed = true; });
  h.suspend(); h.settle(); h.waiting(false);
  h.emit({ type: "agent_start" }); h.settle();
  await nextTask();
  assert.equal(completed, false, "the original prompt still owns resources until it returns");
  h.initial.resolve();
  await prompt;
});

test("terminal await releasing its wait before initial settle still needs the resumed run", async (t) => {
  const h = driverHarness(t);
  let completed = false;
  const prompt = h.driver.prompt("await terminal").then(() => { completed = true; });
  h.suspend("terminal"); h.waiting(false); h.settle(); h.initial.resolve();
  await nextTask();
  assert.equal(completed, false);
  h.emit({ type: "agent_start" }); h.settle();
  await prompt;
});

test("a monitor notification consumed within the same running loop needs no extra wake-up", async (t) => {
  const h = driverHarness(t);
  const prompt = h.driver.prompt("watch");
  h.suspend(); h.waiting(false);
  h.emit({ type: "message_start", message: { role: "assistant" } } as AgentSessionEvent);
  h.settle(); h.initial.resolve();
  await prompt;
});

test("an event after a mixed tool batch still waits for its later continuation", async (t) => {
  const h = driverHarness(t);
  let completed = false;
  const prompt = h.driver.prompt("watch").then(() => { completed = true; });
  h.suspend();
  h.emit({ type: "message_start", message: { role: "assistant" } } as AgentSessionEvent);
  h.waiting(false); h.settle(); h.initial.resolve();
  await nextTask();
  assert.equal(completed, false);
  h.emit({ type: "agent_start" }); h.settle();
  await prompt;
});

test("failed wake-up delivery and cancelling an idle wait reject instead of hanging", async (t) => {
  const h = driverHarness(t);
  const prompt = h.driver.prompt("watch");
  const failure = assert.rejects(prompt, /wake rejected/);
  h.suspend(); h.settle(); h.initial.resolve(); h.waiting(false);
  h.events.emit(BACKGROUND_WAKE_FAILURE_CHANNEL, { error: "wake rejected" });
  await failure;
  const controller = new AbortController();
  const cancelled = h.driver.prompt("watch again", controller.signal);
  const rejection = assert.rejects(cancelled, { name: "AbortError" });
  controller.abort();
  await rejection;
  h.driver.dispose();
  assert.equal(h.listeners.size, 0);
});

test("stopping after wake-up failure preserves the failure instead of replacing it with cancellation", async (t) => {
  const h = driverHarness(t);
  const controller = new AbortController();
  const prompt = h.driver.prompt("watch", controller.signal);
  const failure = assert.rejects(prompt, /original wake failure/);
  h.suspend(); h.settle(); h.initial.resolve(); h.waiting(false);
  h.driver.onExtensionError({ event: "send_message", error: "original wake failure" });
  controller.abort(); h.driver.dispose();
  await failure;
});

test("shutdown extension failures remain reportable after the wait driver is disposed", (t) => {
  const h = driverHarness(t);
  h.driver.dispose();
  h.driver.onExtensionError({ event: "session_shutdown", error: "owned monitor cleanup failed" });
  assert.equal(h.driver.shutdownErrors[0]?.message, "owned monitor cleanup failed");
});

function event(name: string, value: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
}
function startResponse(index: number): string {
  return event("message_start", { type: "message_start", message: { id: `child_${index}`, type: "message", role: "assistant",
    model: "claude-sonnet-5-5", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
}
function endResponse(reason: string): string {
  return event("content_block_stop", { type: "content_block_stop", index: 0 })
    + event("message_delta", { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 20 } })
    + event("message_stop", { type: "message_stop" });
}
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function realChild(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "coil-child-monitor-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "offline-monitor-child" } }));
  const suspended = deferred(), resumed = deferred();
  let calls = 0;
  let settleCount = 0;
  let pid: number | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const encode = new TextEncoder();
  const finish = () => {
    if (!controller || closed) return;
    closed = true;
    controller.enqueue(encode.encode(endResponse("end_turn")));
    controller.close();
  };
  const script = 'const fs=require("node:fs");let done=false;const check=()=>{if(!done&&fs.existsSync("release")){done=true;watch.close();console.log("DONE")}};const watch=fs.watch(".",check);check()';
  const command = `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(startResponse(1)
        + event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "watch", name: "monitor", input: {} } })
        + event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command, event: "exit" }) } })
        + endResponse("tool_use"), { headers: { "Content-Type": "text/event-stream" } });
    }
    assert.equal(calls, 2, "waiting for a process must not issue polling model requests");
    return new Response(new ReadableStream<Uint8Array>({ start(value) {
      controller = value;
      value.enqueue(encode.encode(startResponse(2)
        + event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
        + event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "watch completed" } })));
      resumed.resolve();
    } }), { headers: { "Content-Type": "text/event-stream" } });
  });
  const model = getBuiltinModels("anthropic").find((entry) => entry.id === "claude-sonnet-5-5");
  assert.ok(model);
  const handle = await createChildSession({ cwd: root, agentDir, parentSessionDir: join(root, "sessions"), parentSessionId: "parent",
    model: model as never, tools: ["read", "monitor"], onEvent: (value) => {
      if (value.type === "tool_execution_end" && value.toolName === "monitor") pid = (value.result.details as { pid?: number }).pid;
      if (value.type === "agent_settled" && ++settleCount === 1) suspended.resolve();
    } });
  t.after(async () => { finish(); await handle.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { handle, suspended: suspended.promise, resumed: resumed.promise, release: () => writeFileSync(join(root, "release"), "go"), finish, calls: () => calls, pid: () => pid };
}

test("a real child streams, suspends on a monitor, wakes on process exit and finishes its resumed response", { timeout: 10_000 }, async (t) => {
  const h = await realChild(t);
  let completed = false;
  const prompt = h.handle.prompt("Run the monitored command, wait for its exit, then report.").then(() => { completed = true; });
  await h.suspended;
  await nextTask();
  assert.equal(completed, false);
  assert.equal(h.calls(), 1);
  h.release();
  await h.resumed;
  await nextTask();
  assert.equal(completed, false, "the resumed response is still streaming");
  h.finish();
  await prompt;
  assert.equal(h.calls(), 2);
  const last = h.handle.session.messages.at(-1);
  assert.equal(last?.role, "assistant");
});

test("an actual child reports a wake-up rejected before agent_start", { timeout: 10_000 }, async (t) => {
  const h = await realChild(t);
  const prompt = h.handle.prompt("Run the monitored command.");
  const failed = assert.rejects(prompt, /wake failed before start/);
  await h.suspended;
  t.mock.method(h.handle.session, "sendCustomMessage", async () => { throw new Error("wake failed before start"); });
  h.release();
  await failed;
  assert.equal(h.calls(), 1);
});

test("cancelling an idle child's prompt closes its owned monitor process", { timeout: 10_000 }, async (t) => {
  const h = await realChild(t);
  const controller = new AbortController();
  const prompt = h.handle.prompt("Run the monitored command.", controller.signal);
  const rejected = assert.rejects(prompt, { name: "AbortError" });
  await h.suspended;
  const pid = h.pid();
  assert.equal(typeof pid, "number");
  process.kill(pid!, 0);
  controller.abort();
  await rejected;
  assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
  assert.equal(h.calls(), 1);
});
