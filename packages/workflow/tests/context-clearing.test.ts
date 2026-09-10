import assert from "node:assert/strict";
import test from "node:test";
import contextClearingExtension, {
  applyToolResultClearing,
  clearingLine,
  planToolResultClearing,
  resultKey,
} from "../extensions/context-clearing.ts";

type AgentMessage = Parameters<typeof planToolResultClearing>[0][number];

/** 40 万窗口：pi 的线 383,616，我们的线 373,616。 */
const CONTEXT_WINDOW = 400_000;
const OUR_LINE = clearingLine(CONTEXT_WINDOW);
const PI_LINE = CONTEXT_WINDOW - 16_384;

function toolCall(id: string, name: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: { path: `/src/${id}.ts` } }],
    timestamp: 0,
  } as unknown as AgentMessage;
}

let clock = 0;
function toolResult(id: string, name: string, chars: number, timestamp = ++clock): AgentMessage {
  return {
    role: "toolResult",
    toolName: name,
    toolCallId: id,
    content: [{ type: "text", text: "x".repeat(chars) }],
    timestamp,
  } as unknown as AgentMessage;
}

function said(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: ++clock } as unknown as AgentMessage;
}

/** 一段历史：count 组「调用 + 结果」，每条结果 chars 个字符。 */
function history(count: number, chars = 40_000, name = "read"): AgentMessage[] {
  return Array.from({ length: count }, (_, index) => [
    toolCall(`call-${index}`, name),
    toolResult(`call-${index}`, name, chars),
  ]).flat();
}

/** 尾巴：把最近这一段撑过 5 万 token，代表「正在进行的对话」。 */
function recentTail(): AgentMessage[] {
  return [said("x".repeat(220_000))];
}

test("清的是老的那一段，最近 5 万一个字都不动", () => {
  // 这一层自己划线、自己保护最近一段：pi 摘要时留最近 5 万，我们也留最近 5 万，
  // 两边对「最近」的理解一致，我们清掉的正是 pi 本来也要摘要掉的。
  const messages = [...history(10), ...recentTail()];
  const plan = planToolResultClearing(messages, new Set());
  assert.equal(plan.toolCallIds.length, 10);
  assert.equal(plan.freedTokens, 10 * 10_000);

  // 只有最近这一段的时候，没有任何东西可清。
  assert.deepEqual(planToolResultClearing(recentTail(), new Set()).toolCallIds, []);
});

test("已经清过的不会再算一遍", () => {
  const messages = [...history(10), ...recentTail()];
  const first = planToolResultClearing(messages, new Set());
  const again = planToolResultClearing(messages, new Set(first.toolCallIds));
  assert.deepEqual(again.toolCallIds, [], "第二次没有新的可清");
});

test("太小的结果不值得动，动了只是白打断缓存", () => {
  // 门槛按「换上去的那句说明」定：比说明还短的结果，清了反而更长。
  assert.deepEqual(planToolResultClearing([...history(10, 300), ...recentTail()], new Set()).toolCallIds, []);
  // 几百 token 的浏览器/终端输出是这类会话的大头，必须清得动——门槛 400 的时候，
  // 用户那条真实会话 979 条结果里只够得着 31 条。
  assert.equal(planToolResultClearing([...history(10, 1_000), ...recentTail()], new Set()).toolCallIds.length, 10);
});

test("todo 和 goal 的结果是当前状态，永远不清", () => {
  const messages = [
    ...history(3),
    toolCall("todo-1", "todo"), toolResult("todo-1", "todo", 40_000),
    toolCall("goal-1", "goal"), toolResult("goal-1", "goal", 40_000),
    ...recentTail(),
  ];
  const cleared = new Set(planToolResultClearing(messages, new Set()).toolCallIds);
  assert.equal(cleared.size, 3);
  for (const key of cleared) assert.match(key, /^call-/);
});

test("清理只换掉输出，调用和参数原样留着", () => {
  const messages = history(2);
  const next = applyToolResultClearing(messages, new Set([resultKey(messages[1] as never)]))!;
  const call = next[0] as unknown as { content: Array<{ type: string; name?: string; arguments?: unknown }> };
  assert.equal(call.content[0].name, "read", "调用本身不能动");
  assert.deepEqual(call.content[0].arguments, { path: "/src/call-0.ts" }, "参数是模型重读的依据");
  const cleared = next[1] as unknown as { content: Array<{ type: string; text: string }> };
  assert.match(cleared.content[0].text, /上下文已清理/);
  assert.match(cleared.content[0].text, /重新调用/);
});

test("一条都没清就把上下文原样交回去", () => {
  assert.equal(applyToolResultClearing(history(2), new Set()), undefined);
});

function harness(contextTokens: number) {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const emitted: Array<{ channel: string; value: Record<string, unknown> }> = [];
  const pi = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: {
      emit: (channel: string, value: unknown) => {
        emitted.push({ channel, value: value as Record<string, unknown> });
      },
    },
  };
  contextClearingExtension(pi as never);
  let tokens = contextTokens;
  const ctx = { getContextUsage: () => ({ tokens, contextWindow: CONTEXT_WINDOW, percent: 0 }) };
  return {
    emitted,
    setTokens: (next: number) => { tokens = next; },
    context: (messages: AgentMessage[]) =>
      handlers.get("context")![0]({ messages }, ctx) as { messages: AgentMessage[] } | undefined,
  };
}

test("没到我们的线，什么都不清", () => {
  const h = harness(OUR_LINE - 1);
  assert.equal(h.context([...history(10), ...recentTail()]), undefined, "还没到线，上下文原样发出去");
  assert.deepEqual(h.emitted, []);
});

test("到了我们的线就清一批，落回线下面，对话继续——pi 的线根本碰不到", () => {
  const h = harness(OUR_LINE + 5_000);
  const sent = h.context([...history(10), ...recentTail()])!.messages;
  const record = h.emitted[0].value;
  assert.equal(record.clearedResults, 10);
  assert.equal(record.freedTokens, 100_000);
  assert.equal(record.fitsAgain, true, "清完落回我们的线下面");
  const first = sent[1] as unknown as { content: Array<{ text: string }> };
  assert.match(first.content[0].text, /上下文已清理/, "决定了却没落到请求上，等于什么都没做");
});

test("清完落在两条线中间：也照样继续，pi 不会因此压缩", () => {
  // 用户问的就是这一档。我们的线是「该动手了」，pi 的线才是「必须压缩了」——
  // 落在中间说明还没碰到红线，对话接着走，下次涨到我们的线再清一次。
  // 当前 39 万，清掉一条 1 万 token 的结果 → 38 万，正好在两条线中间。
  const h = harness(390_000);
  h.context([...history(1), ...recentTail()]);
  const record = h.emitted[0].value;
  assert.equal(record.clearedResults, 1);
  assert.equal(record.fitsAgain, false, "没落回我们的线下面");
  const after = (record.contextTokens as number) - (record.freedTokens as number);
  assert.ok(after > OUR_LINE && after < PI_LINE, "落在两条线中间");
});

test("清完还在 pi 的线上面：我们放手，交给 pi 去摘要", () => {
  const h = harness(PI_LINE + 20_000);
  h.context([...history(1), ...recentTail()]);
  const record = h.emitted[0].value;
  assert.equal(record.fitsAgain, false);
  assert.ok((record.contextTokens as number) - (record.freedTokens as number) > PI_LINE, "还在 pi 线上，该它动手了");
  // 关键：这一层不拦 pi，也没有「取消压缩」这回事。
});

test("清干净之后不再重复动手，也不再报", () => {
  const h = harness(OUR_LINE + 5_000);
  const messages = [...history(10), ...recentTail()];
  h.context(messages);
  h.context(messages);
  assert.equal(h.emitted.length, 1, "第二次没有新的可清，就不该再报一条");
});

test("服务商把 tool call id 从 call_0 重新编号，也不能连累后面的结果", () => {
  // 真实事故：pierce/GLM 每轮从 call_0 开始编号，一条会话 996 条结果里 990 条都叫
  // call_0。按 id 记「清过谁」，清掉一条老的等于把这条会话此后所有工具输出全部替换
  // 成那句说明——模型当场变瞎，而磁盘上的会话文件一字不少。
  const older = [toolCall("call_0", "mcp"), toolResult("call_0", "mcp", 40_000)];
  const h = harness(OUR_LINE + 5_000);
  h.context([...older, ...history(9), ...recentTail()]);

  const fresh = [toolCall("call_0", "mcp"), toolResult("call_0", "mcp", 53)];
  const sent = h.context([...older, ...fresh, ...recentTail()])!.messages;
  const clearedOne = sent[1] as unknown as { content: Array<{ text: string }> };
  const freshOne = sent[3] as unknown as { content: Array<{ text: string }> };
  assert.match(clearedOne.content[0].text, /上下文已清理/, "那条老的还是该清");
  assert.equal(freshOne.content[0].text, "x".repeat(53), "刚拿到的这条一个字都不能动");
});

test("同一个 id、同一个大小，只要不是同一条消息就不算清过", () => {
  const h = harness(OUR_LINE + 5_000);
  const old = toolResult("call_0", "read", 40_000, 100);
  h.context([toolCall("call_0", "read"), old, ...history(9), ...recentTail()]);

  // 回到线下面：这一轮不再挑新的东西清，只按记录改写。换一条时间戳不同的同名结
  // 果，没人决定清过它，所以它原样留着。
  h.setTokens(OUR_LINE - 50_000);
  const again = toolResult("call_0", "read", 40_000, 200);
  assert.equal(
    h.context([toolCall("call_0", "read"), again, ...recentTail()]),
    undefined,
    "没有一条匹配得上，这份请求就该原样交出去",
  );
});
