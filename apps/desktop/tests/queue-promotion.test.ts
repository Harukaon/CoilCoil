import assert from "node:assert/strict";
import test from "node:test";
import type { QueuedPrompt } from "@coilcoil/runtime-protocol";
import { conversationMessagesReducer, EMPTY_CONVERSATION_MESSAGES, selectQueuedPrompts } from "../src/renderer/src/features/conversation/conversationMessages.ts";

function withQueue(queue: QueuedPrompt[]) {
  return conversationMessagesReducer(EMPTY_CONVERSATION_MESSAGES, { type: "prompt_queue", queue, revision: 1 });
}

test("a queued prompt stays listed while its promotion is in flight", () => {
  const queued = selectQueuedPrompts(withQueue([{ id: "q1", text: "跑一下测试", queuedAt: 1 }]));
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.status, "queued");

  // Clicking 介入 flags the entry rather than removing it: the steer takes a
  // moment, and dropping the row first left the message nowhere on screen.
  const promoting = selectQueuedPrompts(withQueue([{ id: "q1", text: "跑一下测试", queuedAt: 1, promoting: true }]));
  assert.equal(promoting.length, 1);
  assert.equal(promoting[0]?.status, "running");
  assert.equal(promoting[0]?.text, "跑一下测试");
});

test("the entry only leaves once the runtime drops it from the queue", () => {
  assert.deepEqual(selectQueuedPrompts(withQueue([])), []);
});
