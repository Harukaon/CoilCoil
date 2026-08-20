import assert from "node:assert/strict";
import test from "node:test";
import {
  createNoticeDispatcher,
  formatNotices,
  MAX_BATCH_NOTICES,
  type NoticeDelivery,
  type NoticePayload,
  type TerminalNoticeEvent,
} from "../extensions/terminal/notify.ts";

function event(terminalId: string, overrides: Partial<TerminalNoticeEvent> = {}): TerminalNoticeEvent {
  return {
    terminalId,
    mode: "exit",
    status: "exited",
    reason: "进程已退出（exited）",
    output: `${terminalId} output`,
    at: Date.now(),
    ...overrides,
  };
}

function createRecorder(options: { coalesceMs?: number; maxHoldMs?: number; wakeGraceMs?: number } = {}) {
  const sent: Array<{ payload: NoticePayload; delivery: NoticeDelivery }> = [];
  const dispatcher = createNoticeDispatcher({
    send: (payload, delivery) => sent.push({ payload, delivery }),
    coalesceMs: options.coalesceMs ?? 5,
    maxHoldMs: options.maxHoldMs ?? 10_000,
    wakeGraceMs: options.wakeGraceMs ?? 10_000,
  });
  return { sent, dispatcher };
}

const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("a single event keeps the shape the UI has always parsed", () => {
  const payload = formatNotices([event("term-3")]);
  assert.equal(payload.content, "Terminal term-3：进程已退出（exited）\nterm-3 output");
  assert.equal(payload.details.terminalId, "term-3");
  assert.equal(payload.details.mode, "exit");
  assert.equal(payload.details.status, "exited");
  assert.deepEqual((payload.details.notices as unknown[]).length, 1);
});

test("a batch names every terminal once and keeps a structured copy", () => {
  const payload = formatNotices([
    event("term-1"),
    event("term-2", { mode: "regex", status: "running", reason: "输出匹配正则：ready" }),
  ]);
  assert.match(payload.content, /^2 个终端有新的事件：/);
  assert.match(payload.content, /Terminal term-1：进程已退出/);
  assert.match(payload.content, /Terminal term-2：输出匹配正则：ready/);
  assert.equal(payload.details.count, 2);
  assert.equal(payload.details.terminalId, undefined, "a batch has no single owning terminal");
  const notices = payload.details.notices as Array<Record<string, unknown>>;
  assert.deepEqual(notices.map((notice) => notice.terminalId), ["term-1", "term-2"]);
});

test("output is trimmed to a budget shared by the batch", () => {
  const long = "x".repeat(20_000);
  const payload = formatNotices([event("term-1", { output: long }), event("term-2", { output: long })]);
  assert.ok(payload.content.length < 10_000, `batched message stayed bounded: ${payload.content.length}`);
  assert.match(payload.content, /…x+/);
});

test("a burst of exits becomes one wake-up instead of one per terminal", async () => {
  const { sent, dispatcher } = createRecorder();
  for (const id of ["term-1", "term-2", "term-3", "term-4", "term-5"]) dispatcher.enqueue(event(id));
  await settle();

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.delivery, "followUp");
  assert.match(sent[0]!.payload.content, /^5 个终端有新的事件：/);
  dispatcher.dispose();
});

test("a second event for the same terminal and mode replaces the first", async () => {
  const { sent, dispatcher } = createRecorder();
  dispatcher.enqueue(event("term-1", { output: "first" }));
  dispatcher.enqueue(event("term-1", { output: "second" }));
  await settle();

  assert.equal(sent.length, 1);
  assert.equal((sent[0]!.payload.details.notices as unknown[]).length, 1);
  assert.match(sent[0]!.payload.content, /second/);
  dispatcher.dispose();
});

test("an event a tool call already reported never reaches the Agent", async () => {
  const { sent, dispatcher } = createRecorder();
  dispatcher.enqueue(event("term-1"));
  dispatcher.enqueue(event("term-2"));
  dispatcher.markObserved("term-1");
  await settle();

  assert.equal(sent.length, 1);
  assert.match(sent[0]!.payload.content, /term-2/);
  assert.doesNotMatch(sent[0]!.payload.content, /term-1/);

  dispatcher.enqueue(event("term-9"));
  dispatcher.markObserved("term-9");
  await settle();
  assert.equal(sent.length, 1, "nothing is sent when the batch empties out");
  dispatcher.dispose();
});

test("events wait for the run to settle and then wake exactly one turn", async () => {
  const { sent, dispatcher } = createRecorder();
  dispatcher.setAgentRunning(true);
  dispatcher.enqueue(event("term-1"));
  dispatcher.enqueue(event("term-2"));
  await settle();
  assert.equal(sent.length, 0, "a working Agent is reading these terminals itself");

  dispatcher.setAgentRunning(false);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.delivery, "followUp");
  assert.equal(sent[0]!.payload.details.count, 2);
  dispatcher.dispose();
});

test("a run that holds events too long gets them steered into its own turn", async () => {
  const { sent, dispatcher } = createRecorder({ maxHoldMs: 20 });
  dispatcher.setAgentRunning(true);
  dispatcher.enqueue(event("term-1"));
  await settle(80);

  assert.equal(sent.length, 1, "events cannot wait forever for a run that never settles");
  assert.equal(sent[0]?.delivery, "steer");
  dispatcher.dispose();
});

test("a sent wake-up suppresses a second one until the run reports in", async () => {
  const { sent, dispatcher } = createRecorder({ wakeGraceMs: 60, maxHoldMs: 10_000 });
  dispatcher.enqueue(event("term-1"));
  await settle();
  assert.equal(sent.length, 1);

  dispatcher.enqueue(event("term-2"));
  await settle();
  assert.equal(sent.length, 1, "the turn the first wake-up asked for has not started yet");

  await settle(80);
  assert.equal(sent.length, 2, "a wake-up that produced no run stops holding events back");
  dispatcher.dispose();
});

test("more terminals than one message carries collapse into a count", async () => {
  const { sent, dispatcher } = createRecorder();
  dispatcher.setAgentRunning(true);
  for (let index = 0; index < MAX_BATCH_NOTICES + 3; index += 1) dispatcher.enqueue(event(`term-${index}`));
  dispatcher.setAgentRunning(false);
  await settle();

  assert.equal(sent.length, 1);
  assert.equal((sent[0]!.payload.details.notices as unknown[]).length, MAX_BATCH_NOTICES);
  assert.equal(sent[0]!.payload.details.omitted, 3);
  assert.match(sent[0]!.payload.content, /另有 3 个更早的终端事件已省略/);
  dispatcher.dispose();
});

test("a disposed dispatcher stops sending", async () => {
  const { sent, dispatcher } = createRecorder();
  dispatcher.enqueue(event("term-1"));
  dispatcher.dispose();
  await settle();
  assert.equal(sent.length, 0);
});
