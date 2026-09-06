import assert from "node:assert/strict";
import test from "node:test";
import {
  applyToolResultClearing,
  planToolResultClearing,
} from "../extensions/context-clearing.ts";

type AgentMessage = Parameters<typeof planToolResultClearing>[0][number];

const CONTEXT_WINDOW = 200_000;
const FULL = { tokens: 150_000, contextWindow: CONTEXT_WINDOW };

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 } as AgentMessage;
}

function toolCall(id: string, name: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: { path: `/src/${id}.ts` } }],
    provider: "test",
    model: "test",
    usage: {},
    stopReason: "toolUse",
    timestamp: 0,
  } as unknown as AgentMessage;
}

function toolResult(id: string, name: string, chars: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: "x".repeat(chars) }],
    isError: false,
    timestamp: 0,
  } as AgentMessage;
}

/** A conversation of `count` read calls, each returning `chars` of output. */
function conversation(count: number, chars = 40_000, name = "read"): AgentMessage[] {
  const messages: AgentMessage[] = [user("改一下这个功能")];
  for (let index = 0; index < count; index++) {
    messages.push(toolCall(`call-${index}`, name), toolResult(`call-${index}`, name, chars));
  }
  return messages;
}

test("a roomy window is left alone", () => {
  const plan = planToolResultClearing(conversation(30), new Set(), {
    tokens: 40_000,
    contextWindow: CONTEXT_WINDOW,
  });
  assert.deepEqual(plan.toolCallIds, []);
});

test("the newest tool results are never cleared", () => {
  const plan = planToolResultClearing(conversation(30), new Set(), FULL);
  const cleared = new Set(plan.toolCallIds);
  for (let index = 18; index < 30; index++) {
    assert.equal(cleared.has(`call-${index}`), false, `call-${index} 属于最近 12 条，不该被清理`);
  }
  assert.equal(cleared.has("call-0"), true);
  assert.equal(cleared.size, 18);
});

test("a batch too small to pay for the cache write waits", () => {
  // Twelve results are kept, so only the first one is a candidate, and one
  // 4k-character read is nowhere near the batch minimum.
  const plan = planToolResultClearing(conversation(13, 4_000), new Set(), FULL);
  assert.deepEqual(plan.toolCallIds, []);
});

test("live task state survives clearing", () => {
  const messages = [
    ...conversation(20),
    toolCall("todo-1", "todo"),
    toolResult("todo-1", "todo", 60_000),
    ...conversation(12).slice(1),
  ];
  const plan = planToolResultClearing(messages, new Set(), FULL);
  assert.equal(plan.toolCallIds.includes("todo-1"), false);
});

test("context size unknown right after a compaction clears nothing", () => {
  const plan = planToolResultClearing(conversation(30), new Set(), {
    tokens: null,
    contextWindow: CONTEXT_WINDOW,
  });
  assert.deepEqual(plan.toolCallIds, []);
});

test("clearing keeps the call and replaces only the body", () => {
  const messages = conversation(30);
  const plan = planToolResultClearing(messages, new Set(), FULL);
  const rewritten = applyToolResultClearing(messages, new Set(plan.toolCallIds));
  assert.ok(rewritten);

  const call = rewritten.find(
    (message) => message.role === "assistant" && message.content[0]?.type === "toolCall",
  );
  assert.deepEqual(call, messages[1], "工具调用本身必须原样保留");

  const first = rewritten[2];
  assert.equal(first.role, "toolResult");
  assert.equal(first.content.length, 1);
  assert.match(first.content[0].text, /^\[上下文已清理\] read /);

  const last = rewritten[rewritten.length - 1];
  assert.equal(last.role, "toolResult");
  assert.equal(last.content[0].text.length, 40_000, "最近一条结果必须还是原文");

  assert.equal(messages[2].content[0].text.length, 40_000, "原始消息不能被就地改写");
});

test("an already cleared result is not re-planned, so the boundary stays put", () => {
  const messages = conversation(30);
  const first = planToolResultClearing(messages, new Set(), FULL);
  const cleared = new Set(first.toolCallIds);
  const second = planToolResultClearing(messages, cleared, FULL);
  assert.deepEqual(second.toolCallIds, []);
});

test("nothing cleared means the context is handed on untouched", () => {
  const messages = conversation(30);
  assert.equal(applyToolResultClearing(messages, new Set()), undefined);
  assert.equal(applyToolResultClearing(messages, new Set(["missing"])), undefined);
});
