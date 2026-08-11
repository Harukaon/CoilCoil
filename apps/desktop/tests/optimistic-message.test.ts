import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "@suocode/runtime-protocol";
import { reconcileOptimisticMessage } from "../src/renderer/src/features/conversation/optimisticMessage.ts";

function user(id: string, text: string, order: number): ChatMessage {
  return { id, role: "user", text, order, timestamp: order, status: "succeeded" };
}

test("新会话的空快照不会清掉首条本地消息", () => {
  const optimistic = user("local-1", "你好", 10);
  const messages = reconcileOptimisticMessage([], [optimistic], {
    id: optimistic.id,
    sessionPath: "/sessions/new.jsonl",
  }, "/sessions/new.jsonl");
  assert.deepEqual(messages, [optimistic]);
});

test("正式用户消息到达后会替换本地消息", () => {
  const optimistic = user("local-1", "你好", 10);
  const authoritative = user("message-1", "你好", 1);
  const messages = reconcileOptimisticMessage([authoritative], [optimistic], {
    id: optimistic.id,
    sessionPath: "/sessions/new.jsonl",
  }, "/sessions/new.jsonl");
  assert.deepEqual(messages, [authoritative]);
});

test("乐观消息不会泄漏到其他会话", () => {
  const optimistic = user("local-1", "你好", 10);
  const messages = reconcileOptimisticMessage([], [optimistic], {
    id: optimistic.id,
    sessionPath: "/sessions/new.jsonl",
  }, "/sessions/other.jsonl");
  assert.deepEqual(messages, []);
});
