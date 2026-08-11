import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "@suocode/runtime-protocol";
import {
  conversationMessagesReducer,
  EMPTY_CONVERSATION_MESSAGES,
  selectConversationMessages,
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
