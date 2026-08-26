import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "@coilcoil/runtime-protocol";
import {
  conversationMessagesReducer,
  EMPTY_CONVERSATION_MESSAGES,
  selectConversationMessages,
  selectQueuedPrompts,
} from "../src/renderer/src/features/conversation/conversationMessages.ts";

function user(id: string, text: string, order: number): ChatMessage {
  return { id, role: "user", text, order, timestamp: order, status: "succeeded" };
}

test("新会话创建期间空快照不会清掉已排队的首条消息", () => {
  const local = user("client-1", "你好", 10);
  let state = conversationMessagesReducer(EMPTY_CONVERSATION_MESSAGES, { type: "queue", message: local });
  state = conversationMessagesReducer(state, { type: "bind_session", id: local.id, sessionPath: "/sessions/new.jsonl" });
  state = conversationMessagesReducer(state, { type: "snapshot", sessionPath: "/sessions/new.jsonl", messages: [], revision: 0 });
  assert.deepEqual(selectConversationMessages(state), [local]);
});

test("正式消息使用同一 client id 确认本地消息而不是追加第二条", () => {
  const local = user("client-1", "你好", 10);
  const authoritative = { ...local, order: 1 };
  let state = conversationMessagesReducer(EMPTY_CONVERSATION_MESSAGES, { type: "queue", message: local });
  state = conversationMessagesReducer(state, { type: "runtime_message", message: authoritative, revision: 1 });
  assert.deepEqual(selectConversationMessages(state), [authoritative]);
  assert.equal(state.pending.length, 0);
});

test("同一运行时事件重复投递仍只产生一条消息", () => {
  const local = user("client-1", "你好", 10);
  const authoritative = { ...local, order: 1 };
  let state = conversationMessagesReducer(EMPTY_CONVERSATION_MESSAGES, { type: "queue", message: local });
  state = conversationMessagesReducer(state, { type: "runtime_message", message: authoritative, revision: 1 });
  state = conversationMessagesReducer(state, { type: "runtime_message", message: authoritative, revision: 1 });
  assert.deepEqual(selectConversationMessages(state), [authoritative]);
});

test("切换到其他会话会完整丢弃前一会话的待发送消息", () => {
  const local = user("client-1", "你好", 10);
  let state = conversationMessagesReducer(EMPTY_CONVERSATION_MESSAGES, { type: "queue", message: local });
  state = conversationMessagesReducer(state, { type: "bind_session", id: local.id, sessionPath: "/sessions/new.jsonl" });
  state = conversationMessagesReducer(state, { type: "snapshot", sessionPath: "/sessions/other.jsonl", messages: [], revision: 0 });
  assert.deepEqual(selectConversationMessages(state), []);
});

test("晚到的旧空快照不能覆盖已经开始的用户消息", () => {
  const local = user("client-1", "你好", 10);
  let state = conversationMessagesReducer(EMPTY_CONVERSATION_MESSAGES, { type: "queue", message: local });
  state = conversationMessagesReducer(state, { type: "bind_session", id: local.id, sessionPath: "/sessions/new.jsonl" });
  state = conversationMessagesReducer(state, { type: "runtime_message", message: { ...local, order: 1 }, revision: 1 });
  state = conversationMessagesReducer(state, { type: "snapshot", sessionPath: "/sessions/new.jsonl", messages: [], revision: 0 });
  assert.deepEqual(selectConversationMessages(state), [{ ...local, order: 1 }]);
});

test("切换会话后仍从运行时快照恢复 FIFO 排队消息", () => {
  const queued = { id: "client-queued", text: "稍后处理", queuedAt: 20 };
  let state = conversationMessagesReducer(EMPTY_CONVERSATION_MESSAGES, {
    type: "snapshot",
    sessionPath: "/sessions/a.jsonl",
    messages: [],
    promptQueue: [queued],
    revision: 4,
  });
  // A queued prompt belongs above the composer, where it can be withdrawn or
  // interjected - not in the transcript, which would claim it had been sent.
  assert.deepEqual(selectConversationMessages(state), []);
  assert.equal(selectQueuedPrompts(state)[0]?.status, "queued");
  state = conversationMessagesReducer(state, {
    type: "snapshot",
    sessionPath: "/sessions/b.jsonl",
    messages: [],
    promptQueue: [],
    revision: 0,
  });
  state = conversationMessagesReducer(state, {
    type: "snapshot",
    sessionPath: "/sessions/a.jsonl",
    messages: [],
    promptQueue: [queued],
    revision: 5,
  });
  assert.deepEqual(selectConversationMessages(state), []);
  assert.deepEqual(selectQueuedPrompts(state).map((message) => [message.id, message.status]), [["client-queued", "queued"]]);
});

test("排队消息只出现在面板里，并按入队顺序排列", () => {
  const state = conversationMessagesReducer(EMPTY_CONVERSATION_MESSAGES, {
    type: "snapshot",
    sessionPath: "/sessions/a.jsonl",
    messages: [user("m1", "第一条", 1), { ...user("a1", "回复", 2), role: "assistant" }],
    promptQueue: [
      { id: "q2", text: "后排队的", queuedAt: 200 },
      { id: "q1", text: "先排队的", queuedAt: 100 },
    ],
    revision: 3,
  });
  assert.deepEqual(selectConversationMessages(state).map((message) => message.id), ["m1", "a1"]);
  assert.deepEqual(selectQueuedPrompts(state).map((message) => message.id), ["q1", "q2"]);
});

test("介入的消息留在对话里直到本轮结束才落地", () => {
  // Pi accepts a steer immediately but only appends it when the running turn
  // ends. Between those two moments it is in no queue and no transcript, which
  // is exactly when it used to look like it had been swallowed.
  const steered = { ...user("client-steer", "顺便改一下标题", 300), status: "steering" as const };
  let state = conversationMessagesReducer(EMPTY_CONVERSATION_MESSAGES, {
    type: "snapshot",
    sessionPath: "/sessions/a.jsonl",
    messages: [user("m1", "第一条", 1)],
    revision: 1,
  });
  state = conversationMessagesReducer(state, { type: "queue", message: steered, sessionPath: "/sessions/a.jsonl" });

  assert.deepEqual(
    selectConversationMessages(state).map((message) => [message.id, message.status]),
    [["m1", "succeeded"], ["client-steer", "steering"]],
  );
  // It is not a queue row: nothing above the composer can withdraw it any more.
  assert.deepEqual(selectQueuedPrompts(state), []);

  state = conversationMessagesReducer(state, {
    type: "runtime_message",
    message: user("client-steer", "顺便改一下标题", 2),
    revision: 2,
    sessionPath: "/sessions/a.jsonl",
  });

  // Once Pi appends it, the committed message replaces the marked one.
  assert.deepEqual(
    selectConversationMessages(state).map((message) => [message.id, message.status]),
    [["m1", "succeeded"], ["client-steer", "succeeded"]],
  );
});

test("快照同时带着队列占位和正式消息时只画一条气泡", () => {
  // Pi echoes the user message before the runtime drops its queue row, so a
  // snapshot taken in that window carries the prompt in both lists.
  const state = conversationMessagesReducer(EMPTY_CONVERSATION_MESSAGES, {
    type: "snapshot",
    sessionPath: "/sessions/a.jsonl",
    messages: [{ ...user("q1", "跑一下测试", 5), status: undefined }],
    promptQueue: [{ id: "q1", text: "跑一下测试", queuedAt: 100 }],
    revision: 2,
  });
  assert.deepEqual(
    selectConversationMessages(state).map((message) => [message.id, message.order, message.status]),
    [["q1", 5, undefined]],
  );
});

test("队列投影在正式 user message 到达时只保留一条消息", () => {
  const queued = { id: "client-queued", text: "排队消息", queuedAt: 20 };
  let state = conversationMessagesReducer(EMPTY_CONVERSATION_MESSAGES, {
    type: "prompt_queue",
    queue: [queued],
    revision: 1,
    sessionPath: "/sessions/a.jsonl",
  });
  state = { ...state, sessionPath: "/sessions/a.jsonl" };
  state = conversationMessagesReducer(state, {
    type: "runtime_message",
    message: { ...user("client-queued", "排队消息", 2), status: undefined },
    revision: 2,
    sessionPath: "/sessions/a.jsonl",
  });
  // Once Pi echoes the prompt it leaves the queue and becomes a real message.
  assert.deepEqual(selectConversationMessages(state).map((message) => message.id), ["client-queued"]);
  assert.deepEqual(selectQueuedPrompts(state), []);
});
