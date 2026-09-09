import assert from "node:assert/strict";
import test from "node:test";
import {
  applyToolResultClearing,
  clearingRelievesPressure,
  planToolResultClearing,
} from "../extensions/context-clearing.ts";

type AgentMessage = Parameters<typeof planToolResultClearing>[0][number];

const CONTEXT_WINDOW = 272_000;

function toolCall(id: string, name: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: { path: `/src/${id}.ts` } }],
    timestamp: 0,
  } as unknown as AgentMessage;
}

function toolResult(id: string, name: string, chars: number): AgentMessage {
  return {
    role: "toolResult",
    toolName: name,
    toolCallId: id,
    content: [{ type: "text", text: "x".repeat(chars) }],
    timestamp: 0,
  } as unknown as AgentMessage;
}

/** The stretch Pi hands over as `preparation.messagesToSummarize`. */
function discardable(count: number, chars = 40_000, name = "read"): AgentMessage[] {
  return Array.from({ length: count }, (_, index) => [
    toolCall(`call-${index}`, name),
    toolResult(`call-${index}`, name, chars),
  ]).flat();
}

test("清理的范围就是 Pi 准备丢掉的那一段", () => {
  // 这是整个设计的关键：触发点、保护范围都由 Pi 决定。自己另起一套的时候，
  // 触发点在一个会话里响了 289 次，保护范围「最新 12 条」让一半的轮次清掉了
  // 自己正在用的输出——两样都是自造标准才会犯的错。
  const plan = planToolResultClearing(discardable(10), new Set());
  assert.equal(plan.toolCallIds.length, 10, "给什么范围就在什么范围里清");
  assert.equal(plan.freedTokens, 10 * 10_000);
});

test("最近的对话根本不会传进来，所以不可能被误伤", () => {
  // Pi 已经把要保留的那一段排除在 messagesToSummarize 之外了。
  assert.deepEqual(planToolResultClearing([], new Set()).toolCallIds, []);
});

test("已经清过的不会再算一遍", () => {
  const messages = discardable(10);
  const first = planToolResultClearing(messages, new Set());
  const again = planToolResultClearing(messages, new Set(first.toolCallIds));
  assert.deepEqual(again.toolCallIds, [], "第二次没有新的可清");
});

test("太小的结果不值得动，动了只是白打断缓存", () => {
  assert.deepEqual(planToolResultClearing(discardable(10, 1_000), new Set()).toolCallIds, []);
});

test("todo 和 goal 的结果是当前状态，永远不清", () => {
  const messages = [
    ...discardable(3),
    toolCall("todo-1", "todo"), toolResult("todo-1", "todo", 40_000),
    toolCall("goal-1", "goal"), toolResult("goal-1", "goal", 40_000),
  ];
  const cleared = new Set(planToolResultClearing(messages, new Set()).toolCallIds);
  assert.equal(cleared.has("todo-1"), false);
  assert.equal(cleared.has("goal-1"), false);
  assert.equal(cleared.size, 3);
});

test("腾不出够多就别取消摘要——只推迟一轮不值得", () => {
  const small = planToolResultClearing(discardable(1, 4_000), new Set());
  assert.equal(clearingRelievesPressure(small, CONTEXT_WINDOW), false);
  const big = planToolResultClearing(discardable(10), new Set());
  assert.equal(clearingRelievesPressure(big, CONTEXT_WINDOW), true);
});

test("够不够按窗口比例算，同一个数字在两种模型上说的不是一回事", () => {
  const plan = planToolResultClearing(discardable(3), new Set());   // 30,000 token
  assert.equal(clearingRelievesPressure(plan, 272_000), true, "272k 的 5% 是 13,600，够了");
  assert.equal(clearingRelievesPressure(plan, 1_050_000), false, "1M 的 5% 是 52,500，不够");
});

test("清理只换掉输出，调用和参数原样留着", () => {
  const messages = discardable(2);
  const next = applyToolResultClearing(messages, new Set(["call-0"]))!;
  const call = next[0] as unknown as { content: Array<{ type: string; name?: string; arguments?: unknown }> };
  assert.equal(call.content[0].name, "read", "调用本身不能动");
  assert.deepEqual(call.content[0].arguments, { path: "/src/call-0.ts" }, "参数是模型重读的依据");
  const cleared = next[1] as unknown as { content: Array<{ type: string; text: string }> };
  assert.match(cleared.content[0].text, /上下文已清理/);
  assert.match(cleared.content[0].text, /重新调用/);
  const untouched = next[3] as unknown as { content: Array<{ text: string }> };
  assert.equal(untouched.content[0].text.length, 40_000, "没被点名的那条一个字都不能少");
});

test("一条都没清就把上下文原样交回去", () => {
  assert.equal(applyToolResultClearing(discardable(2), new Set()), undefined);
});
