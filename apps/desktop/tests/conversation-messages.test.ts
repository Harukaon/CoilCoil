import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "@suocode/runtime-protocol";
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
  // Queued prompts are projected separately: they are not in the transcript.
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
