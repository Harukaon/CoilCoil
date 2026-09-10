import assert from "node:assert/strict";
import test from "node:test";
import contextClearingExtension, {
  applyToolResultClearing,
  clearingRelievesPressure,
  planToolResultClearing,
  resultKey,
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
  // 门槛按「换上去的那句说明」定：比说明还短的结果，清了反而更长。
  assert.deepEqual(planToolResultClearing(discardable(10, 300), new Set()).toolCallIds, []);
  // 几百 token 的浏览器/终端输出是这类会话的大头，必须清得动——门槛 400 的时候，
  // 用户那条真实会话 979 条结果里只够得着 31 条。
  assert.equal(planToolResultClearing(discardable(10, 1_000), new Set()).toolCallIds.length, 10);
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

test("放行的条件是「清完还塞得下」，不是「清出了一点」", () => {
  // 出事故的就是这一条：上下文已经顶到天花板，清出一点点也算数，于是放行，下一个
  // 请求直接被服务商拒收。窗口 40 万、预留 1.6 万，线在 38.36 万，我们的线再低
  // 1 万 = 37.36 万。
  const line = 400_000 - 16_384;
  const small = planToolResultClearing(discardable(1, 4_000), new Set());   // 1,000 token
  assert.equal(
    clearingRelievesPressure(small, 400_000, 390_000),
    false,
    "还在天花板上面，清这一点等于没清",
  );
  const big = planToolResultClearing(discardable(3), new Set());            // 30,000 token
  assert.equal(clearingRelievesPressure(big, 400_000, 390_000), true, "落到线下 1 万以内才算数");
  assert.equal(
    clearingRelievesPressure(big, 400_000, line + 25_000),
    false,
    "差一点点也不放行——放行了下一轮就又回来了",
  );
});

test("我们的线比 pi 的低 1 万，两层不会在同一条线上互相顶", () => {
  const plan = planToolResultClearing(discardable(1, 40_000), new Set());   // 10,000 token
  const window = 200_000;
  const line = window - 16_384;
  // 清完正好落在 pi 的线上：不放行，因为下一轮立刻又到阈值。
  assert.equal(clearingRelievesPressure(plan, window, line + 10_000), false);
  // 清完落到线下一万：放行。
  assert.equal(clearingRelievesPressure(plan, window, line), true);
});

test("清理只换掉输出，调用和参数原样留着", () => {
  const messages = discardable(2);
  const next = applyToolResultClearing(messages, new Set([resultKey(messages[1] as never)]))!;
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

/* 上面测的都是纯函数。下面测接线本身——挂没挂对事件、到底返没返回 cancel。
   这一层没测，正是之前几次问题的共同点：函数都对，接错了地方。 */

function harness() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const emitted: Array<{ channel: string; value: unknown }> = [];
  const pi = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: { emit: (channel: string, value: unknown) => { emitted.push({ channel, value }); } },
  };
  contextClearingExtension(pi as never);
  // Pi 只在越过它那条线之后才会走到这个钩子，所以这里就是那一刻的状态：窗口 27.2 万、
  // 线在 25.56 万，当前 26.2 万，已经在线上面了。
  const ctx = { getContextUsage: () => ({ tokens: 262_000, contextWindow: CONTEXT_WINDOW, percent: 96 }) };
  return {
    emitted,
    beforeCompact: (
      reason: string,
      messagesToSummarize: AgentMessage[],
      preparation: { isSplitTurn?: boolean; turnPrefixMessages?: AgentMessage[] } = {},
    ) =>
      handlers.get("session_before_compact")![0](
        { reason, preparation: { messagesToSummarize, ...preparation } },
        ctx,
      ) as { cancel?: boolean } | undefined,
    context: (messages: AgentMessage[]) =>
      handlers.get("context")![0]({ messages }, ctx) as { messages: AgentMessage[] } | undefined,
  };
}

test("接在 Pi 的压缩决策上：清得动就取消摘要", () => {
  const h = harness();
  const result = h.beforeCompact("threshold", discardable(10));
  assert.deepEqual(result, { cancel: true }, "清得动就该拦下这次摘要");
  assert.equal(h.emitted.length, 1, "要报出去，界面上才画得出那条线");
  assert.equal(h.emitted[0].channel, "coilcoil:context-clearing:v1");
});

test("清不动就让它照常摘要，但也要留一句话说自己没清", () => {
  const h = harness();
  // 一条 4k 字符的结果远不到窗口的 5%，拦下来只是把同一次压缩推迟一轮。
  assert.equal(h.beforeCompact("threshold", discardable(1, 4_000)), undefined);
  assert.equal(h.emitted.length, 1, "没清也要报，否则日志里分不出「没清」和「没跑」");
  const record = h.emitted[0].value as { clearedResults: number; cancelledCompaction: boolean; candidates: number };
  assert.equal(record.clearedResults, 0);
  assert.equal(record.cancelledCompaction, false);
  assert.equal(record.candidates, 1);
});

test("Pi 在切一个大回合时，前半段也要清——那正是最需要清的时候", () => {
  // 用户那条会话就是这样：二十小时的浏览器操作压在几个回合里，Pi 要丢的几乎全在
  // 当前这个回合的前半段。以前这一段不碰，于是清理在最该出力的场合一点忙都没帮上，
  // 而 Pi 那边的「回合前缀摘要」又一直失败，上下文一路涨到超窗 24%。
  const h = harness();
  const result = h.beforeCompact("threshold", [], { isSplitTurn: true, turnPrefixMessages: discardable(10) });
  assert.deepEqual(result, { cancel: true });
  const record = h.emitted[0].value as { clearedResults: number; splitTurn: boolean };
  assert.equal(record.clearedResults, 10);
  assert.equal(record.splitTurn, true);
});

test("没在切回合时，回合前缀不存在，也就不会被误清", () => {
  const h = harness();
  assert.equal(h.beforeCompact("threshold", [], { isSplitTurn: false, turnPrefixMessages: discardable(10) }), undefined);
  const record = h.emitted[0].value as { candidates: number };
  assert.equal(record.candidates, 0, "Pi 没打算丢它，我们也不动");
});

test("手动 /compact 和溢出恢复不拦", () => {
  // 手动是用户明确要一份摘要；溢出时请求已经炸了，再省这点没有意义。
  for (const reason of ["manual", "overflow"]) {
    const h = harness();
    assert.equal(h.beforeCompact(reason, discardable(10)), undefined, `${reason} 不该被拦`);
  }
});

test("拦下来之后，清理真的落在发出去的那一份上", () => {
  const h = harness();
  const older = discardable(10);
  h.beforeCompact("threshold", older);
  const sent = h.context([...older, ...discardable(2)])!.messages;
  const first = sent[1] as unknown as { content: Array<{ text: string }> };
  assert.match(first.content[0].text, /上下文已清理/, "决定了却没落到请求上，等于什么都没做");
});

test("同一次压缩不会被拦两次", () => {
  const h = harness();
  const older = discardable(10);
  assert.deepEqual(h.beforeCompact("threshold", older), { cancel: true });
  assert.equal(h.beforeCompact("threshold", older), undefined, "没有新的可清了，就得放它去摘要");
});

test("服务商把 tool call id 从 call_0 重新编号，也不能连累后面的结果", () => {
  // 真实事故：pierce/GLM 每轮从 call_0 开始编号，一条会话 996 条结果里 990 条都叫
  // call_0。按 id 记「清过谁」，清掉一条老的等于把这条会话此后所有工具输出全部替换
  // 成那句说明——模型当场变瞎，而磁盘上的会话文件一字不少。
  const older = [toolCall("call_0", "mcp"), toolResult("call_0", "mcp", 40_000)];
  const h = harness();
  assert.deepEqual(h.beforeCompact("threshold", [...older, ...discardable(9)]), { cancel: true });

  const fresh = [toolCall("call_0", "mcp"), toolResult("call_0", "mcp", 53)];
  const sent = h.context([...older, ...fresh])!.messages;
  const clearedOne = sent[1] as unknown as { content: Array<{ text: string }> };
  const freshOne = sent[3] as unknown as { content: Array<{ text: string }> };
  assert.match(clearedOne.content[0].text, /上下文已清理/, "那条老的还是该清");
  assert.equal(freshOne.content[0].text, "x".repeat(53), "刚拿到的这条一个字都不能动");
});

test("同一个 id、同一个大小，只要不是同一条消息就不算清过", () => {
  const h = harness();
  const old = toolResult("call_0", "read", 40_000, 100);
  h.beforeCompact("threshold", [toolCall("call_0", "read"), old, ...discardable(9)]);
  // 换一条时间戳不同的同名结果：没人决定清它，所以这一份请求原样交出去。
  const again = toolResult("call_0", "read", 40_000, 200);
  assert.equal(h.context([toolCall("call_0", "read"), again]), undefined, "新的那条没被任何人决定清掉");
});
