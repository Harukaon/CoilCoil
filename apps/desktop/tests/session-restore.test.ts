import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { RuntimeEvent, SessionSnapshot } from "@coilcoil/runtime-protocol";
import { SessionRestoreController } from "../src/renderer/src/features/conversation/sessionRestore";
import { useRuntimeEventHandler } from "../src/renderer/src/hooks/useRuntimeEventHandler";
import { coalesceRuntimeEvents, type BufferedRuntimeEvent } from "../src/renderer/src/hooks/useBufferedRuntimeEvents";
import { conversationMessagesReducer, EMPTY_CONVERSATION_MESSAGES, selectConversationMessages, selectQueuedPrompts } from "../src/renderer/src/features/conversation/conversationMessages";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function snapshot(name: string, revision = 0, text = ""): SessionSnapshot {
  return { runtimeId: `runtime-${name}`, session: { id: name, path: `/${name}`, cwd: "/project" },
    messageRevision: revision, messages: text ? [{ id: "assistant", role: "assistant", text, order: 1, timestamp: 1, status: "running" }] : [],
    promptQueue: [], steering: [], tools: [], subagents: [], project: { cwd: "/project" }, running: true,
  } as unknown as SessionSnapshot;
}

function harness() {
  let messages = EMPTY_CONVERSATION_MESSAGES;
  const snapshotRef = { current: undefined as SessionSnapshot | undefined };
  const snapshotCacheRef = { current: new Map<string, SessionSnapshot>() };
  const runtimeSessionRef = { current: new Map([['runtime-A', '/A'], ['runtime-B', '/B']]) };
  const dispatch = (action: Parameters<typeof conversationMessagesReducer>[1]) => { messages = conversationMessagesReducer(messages, action); };
  const applySnapshot = (next: SessionSnapshot) => {
    snapshotRef.current = next;
    snapshotCacheRef.current.set(next.session.path, next);
    dispatch({ type: "snapshot", sessionPath: next.session.path, runtimeId: next.runtimeId, revision: next.messageRevision ?? 0,
      messages: next.messages, promptQueue: next.promptQueue, steering: next.steering });
  };
  let handler!: ReturnType<typeof useRuntimeEventHandler>;
  function Capture() {
    handler = useRuntimeEventHandler({ snapshotRef, snapshotCacheRef, runtimeSessionRef,
      optimisticSessionsRef: { current: new Map() }, applySnapshot, dispatchConversationMessages: dispatch,
      restoreDraft() {}, restoreDocument() {},
      setSnapshot: (update) => { snapshotRef.current = typeof update === "function" ? update(snapshotRef.current) : update; },
      setSessionActivity() {}, setConfiguration() {}, setSessionsByProject() {}, setAgentPhase() {}, setTools() {}, setProjectState() {}, setSubagents() {},
    });
    return null;
  }
  renderToStaticMarkup(createElement(Capture));
  const apply = ({ event, runtimeId, deltaParts }: BufferedRuntimeEvent) => handler(event, runtimeId, deltaParts);
  const restore = new SessionRestoreController(apply, (runtimeId) => runtimeSessionRef.current.get(runtimeId));
  return { applySnapshot, snapshotRef, snapshotCacheRef, apply, restore, messages: () => messages };
}

function delta(revision: number, text: string): BufferedRuntimeEvent {
  return { runtimeId: "runtime-A", event: { type: "message_delta", id: "assistant", field: "text", delta: text, revision } };
}

test("反例：缺少恢复窗口时，rev11增量会让携带介入和历史的rev10快照整份被丢弃", () => {
  const h = harness();
  h.applySnapshot(snapshot("A", 1));
  h.apply(delta(11, "tail"));
  h.applySnapshot({ ...snapshot("A", 10, "head"), steering: [{ id: "steer", text: "修改布局", timestamp: 2 }] });
  assert.equal(selectConversationMessages(h.messages())[0].text, "tail");
  assert.equal(selectConversationMessages(h.messages()).some((message) => message.id === "steer"), false);
});

test("真实事件hook：介入/排队后切走再回来，先恢复完整快照再重放缓冲正文，之后继续渲染", async () => {
  const h = harness();
  const cached = snapshot("A", 1);
  h.applySnapshot(cached);
  h.apply({ runtimeId: "runtime-A", event: { type: "message_steering", id: "steer", text: "修改布局", timestamp: 2, revision: 2 } });
  h.apply({ runtimeId: "runtime-A", event: { type: "prompt_queue_updated", queue: [{ id: "queued", text: "然后测试", queuedAt: 3 }], revision: 3 } });
  h.applySnapshot(snapshot("B"));
  h.applySnapshot(cached);
  const response = deferred<SessionSnapshot>();
  const opening = h.restore.restore("/A", "runtime-A", () => response.promise, h.applySnapshot);
  for (const entry of coalesceRuntimeEvents([delta(9, "old"), delta(11, "tail")])) h.restore.handle(entry);
  response.resolve({ ...snapshot("A", 10, "head"), steering: [{ id: "steer", text: "修改布局", timestamp: 2 }],
    promptQueue: [{ id: "queued", text: "然后测试", queuedAt: 3 }] });
  await opening;
  assert.deepEqual(selectConversationMessages(h.messages()).map((message) => message.text), ["headtail", "修改布局"]);
  assert.deepEqual(selectQueuedPrompts(h.messages()).map((message) => message.text), ["然后测试"]);
  h.restore.handle(delta(12, "more"));
  assert.equal(selectConversationMessages(h.messages())[0].text, "headtailmore");
  h.restore.handle({ runtimeId: "runtime-A", event: { type: "run_state", running: false } });
  assert.equal(h.snapshotRef.current?.running, false);
  assert.equal(h.snapshotCacheRef.current.get("/A")?.running, false);
});

test("A→B加载中→点回A，B迟到响应不改变最终选择", async () => {
  const h = harness();
  h.applySnapshot(snapshot("A"));
  const b = deferred<SessionSnapshot>(), a = deferred<SessionSnapshot>();
  const toB = h.restore.restore("/B", "runtime-B", () => b.promise, h.applySnapshot);
  const cancelled = assert.rejects(toB);
  const toA = h.restore.restore("/A", "runtime-A", () => a.promise, h.applySnapshot);
  a.resolve(snapshot("A", 3, "current"));
  await toA;
  b.resolve(snapshot("B", 4, "late"));
  await cancelled;
  assert.equal(h.snapshotRef.current?.runtimeId, "runtime-A");
  assert.equal(selectConversationMessages(h.messages())[0].text, "current");
});

test("首次打开尚无runtime映射的会话，snapshot事件确定归属后继续缓冲增量", async () => {
  const h = harness();
  const restore = new SessionRestoreController(h.apply, () => undefined);
  const response = deferred<SessionSnapshot>();
  const opening = restore.restore("/A", undefined, () => response.promise, h.applySnapshot);
  restore.handle({ runtimeId: "runtime-A", event: { type: "session_snapshot", snapshot: snapshot("A", 1) } });
  restore.handle(delta(11, "tail"));
  response.resolve(snapshot("A", 10, "head"));
  await opening;
  assert.equal(selectConversationMessages(h.messages())[0].text, "headtail");
});

test("恢复缓存只活到本次请求结束：超限或超时明确失败，下次打开不重放失败窗口", async () => {
  const applied: RuntimeEvent[] = [];
  const restore = new SessionRestoreController(({ event }) => applied.push(event), () => "/A", { timeoutMs: 10, maxEvents: 2 });
  const never = () => new Promise<SessionSnapshot>(() => {});
  const overflow = restore.restore("/A", "runtime-A", never, () => {});
  restore.handle(delta(1, "a")); restore.handle(delta(2, "b")); restore.handle(delta(3, "c"));
  await assert.rejects(overflow, /事件过多/);
  await assert.rejects(restore.restore("/A", "runtime-A", never, () => {}), /超时/);
  await restore.restore("/A", "runtime-A", async () => snapshot("A", 4), () => {});
  assert.deepEqual(applied, []);
});

test("关闭界面会释放恢复窗口，迟到响应和缓冲事件不再写入已关闭的视图", async () => {
  const applied: BufferedRuntimeEvent[] = [];
  const restore = new SessionRestoreController((entry) => applied.push(entry), () => "/A");
  const response = deferred<SessionSnapshot>();
  let snapshots = 0;
  const opening = restore.restore("/A", "runtime-A", () => response.promise, () => { snapshots++; });
  const rejected = assert.rejects(opening);
  restore.handle(delta(1, "pending"));
  restore.cancel(false);
  response.resolve(snapshot("A", 1, "late"));
  await rejected;
  assert.equal(snapshots, 0);
  assert.deepEqual(applied, []);
});

test("固定种子200组快照/增量交错，恢复后正文完整且每个revision仅出现一次", async () => {
  let seed = 0x51E3A7;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let run = 0; run < 200; run++) {
    const h = harness();
    h.applySnapshot(snapshot("A", 0));
    const cutoff = 1 + random() % 15;
    const length = cutoff + 1 + random() % 20;
    const tokens = Array.from({ length }, (_, index) => `[${index + 1}]`);
    const response = deferred<SessionSnapshot>();
    const opening = h.restore.restore("/A", "runtime-A", () => response.promise, h.applySnapshot);
    const events = tokens.map((text, index) => delta(index + 1, text));
    const split = random() % (events.length + 1);
    for (const entry of coalesceRuntimeEvents(events.slice(0, split))) h.restore.handle(entry);
    response.resolve(snapshot("A", cutoff, tokens.slice(0, cutoff).join("")));
    await opening;
    for (const entry of coalesceRuntimeEvents(events.slice(split))) h.restore.handle(entry);
    assert.equal(selectConversationMessages(h.messages())[0].text, tokens.join(""), `seed sequence ${run}`);
  }
});
