import assert from "node:assert/strict";
import test from "node:test";
import contextClearingExtension, {
  applyToolResultClearing,
  clearForSummary,
  clearingLine,
  planToolResultClearing,
  resultKey,
} from "../extensions/context-clearing.ts";

type AgentMessage = Parameters<typeof planToolResultClearing>[0][number];

/** 40 万窗口：pi 的线 383,616，我们的线 373,616。 */
const CONTEXT_WINDOW = 400_000;
const OUR_LINE = clearingLine(CONTEXT_WINDOW);
const PI_LINE = CONTEXT_WINDOW - 16_384;

function toolCall(id: string, name: string, args: unknown = { path: `/src/${id}.ts` }): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
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

/** 尾巴：把最近这一段撑过 2 万 token，代表「正在进行的对话」。 */
function recentTail(): AgentMessage[] {
  return [said("x".repeat(100_000))];
}

test("清的是老的那一段，最近 2 万一个字都不动", () => {
  // 这一层自己划线、自己保护最近一段：pi 摘要时留最近 2 万，我们也留最近 2 万，
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

test("再小的结果也清，单条没有门槛", () => {
  // 「不要看它小就不删，它有可能几百次、成千次调用，积少成多也会很大」。曾经的
  // 单条门槛是 400 token，用户那条真实会话 979 条结果平均 127 token，够得着的只有
  // 31 条——剩下那 948 条才是把窗口填满的东西。
  const plan = planToolResultClearing([...history(10, 300), ...recentTail()], new Set());
  assert.equal(plan.toolCallIds.length, 10);
  assert.equal(plan.freedTokens, 10 * 75);
});

test("大参数跟着输出一起清，留下的只有「调过这个工具」", () => {
  // 一条 grep 的正则不大，几百条就不小了。清完之后调用块还在、名字还在，参数换成
  // 一句占位。
  const big = { pattern: "x".repeat(40_000) };
  const messages = [toolCall("c1", "grep", big), toolResult("c1", "grep", 40_000), ...recentTail()];
  const plan = planToolResultClearing(messages, new Set());
  assert.equal(plan.callIds.length, 1, "参数该进这一批");
  assert.ok(plan.freedTokens > 19_000, "参数和输出都算进腾出来的量");

  const next = applyToolResultClearing(messages, new Set([...plan.toolCallIds, ...plan.callIds]))!;
  const call = next[0] as unknown as { content: Array<{ name?: string; arguments?: unknown }> };
  assert.equal(call.content[0].name, "grep", "调过什么工具还得看得见");
  assert.deepEqual(call.content[0].arguments, { note: "[上下文已清理]" });
});

test("参数小到还不如占位句，就别动它", () => {
  const messages = [...history(2), ...recentTail()];
  assert.deepEqual(planToolResultClearing(messages, new Set()).callIds, []);
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

test("只清被点名的那几条，别的原样留着", () => {
  const messages = history(2);
  const next = applyToolResultClearing(messages, new Set([resultKey(messages[1] as never)]))!;
  const call = next[0] as unknown as { content: Array<{ type: string; name?: string; arguments?: unknown }> };
  assert.equal(call.content[0].name, "read", "调用本身不能动");
  assert.deepEqual(call.content[0].arguments, { path: "/src/call-0.ts" }, "没被点名的参数不动");
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
    compacted: () => { for (const h of handlers.get("session_compact") ?? []) h({}, ctx); },
    compactionFailed: (aborted = false) => {
      for (const h of handlers.get("session_compact_failed") ?? []) h({ aborted }, ctx);
    },
    context: (messages: AgentMessage[]) =>
      handlers.get("context")![0]({ messages }, ctx) as { messages: AgentMessage[] } | undefined,
  };
}

test("一批腾不出 2000 token 就先不动，免得白打断缓存", () => {
  // 单条不设门槛，但每清一次都要重写一遍提示词、打碎服务商的缓存——一次只腾出
  // 几百 token 的「碎屑」清理，买一轮对话要付两次钱。
  const h = harness(OUR_LINE + 5_000);
  assert.equal(h.context([...history(4, 300), ...recentTail()]), undefined, "1200 token，不值得动");
  assert.deepEqual(h.emitted, []);
  h.context([...history(30, 300), ...recentTail()]);
  assert.equal(h.emitted.length, 1, "凑够一批就该动手");
});

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

test("读数大得不可能的时候，不拿这一轮仅有的一次清理去赌", () => {
  // 真实一次：网关在重试里把缓存读取重复计，200K 的窗口报回来 433K。一个被接受
  // 的请求按定义装得下窗口，它之后补上的东西也不可能再多出半个窗口——所以这种数
  // 只说明服务商算错了。
  const h = harness(CONTEXT_WINDOW * 1.6);
  assert.equal(h.context([...history(10), ...recentTail()]), undefined);
  assert.deepEqual(h.emitted, []);

  // 而真的超窗（超出去一点）照常动手，那正是最需要清的时候。
  h.setTokens(CONTEXT_WINDOW + 10_000);
  h.context([...history(10), ...recentTail()]);
  assert.equal(h.emitted.length, 1);
});

test("交给 pi 去摘要的那一段，工具内容全清掉", () => {
  // 这是压缩一直失败的真正原因：pi 做摘要读的是磁盘上那份原始会话，不是我们改过
  // 的拷贝。同一条会话，平时发给模型 13 万 token，pi 拿去摘要 49 万——窗口只有 20
  // 万，上游秒拒。交给它总结的这一段按定义整段都要被折叠，所以不留情面。
  const messages = [...history(6), ...history(2, 40_000, "grep")];
  const before = JSON.stringify(messages).length;
  const done = clearForSummary(messages as never[]);

  assert.equal(done.cleared, 8, "八条结果全清了");
  assert.ok(JSON.stringify(messages).length < before / 5, "该瘦掉一大截");
  // 调过什么工具还看得见，摘要要的正是这个。
  const call = messages[0] as unknown as { content: Array<{ name?: string }> };
  assert.equal(call.content[0].name, "read");
  const result = messages[1] as unknown as { content: Array<{ text: string }> };
  assert.match(result.content[0].text, /上下文已清理/);
});

test("摘要那一段里，todo 和 goal 照样留着", () => {
  const messages = [
    ...history(2),
    toolCall("todo-1", "todo"), toolResult("todo-1", "todo", 40_000),
  ];
  clearForSummary(messages as never[]);
  const todo = messages[5] as unknown as { content: Array<{ text: string }> };
  assert.equal(todo.content[0].text.length, 40_000, "当前状态不能在摘要里丢掉");
});

test("压缩之前先把那一段瘦下来，pi 自己的逻辑一行不动", () => {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const pi = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: { emit: () => {} },
  };
  contextClearingExtension(pi as never);

  const messagesToSummarize = [...history(4)];
  const turnPrefixMessages = [...history(2, 40_000, "grep")];
  const preparation = { messagesToSummarize, turnPrefixMessages };
  const result = handlers.get("session_before_compact")![0]({ preparation }, {});

  assert.equal(result, undefined, "什么都不返回，摘要还是 pi 自己做");
  for (const slice of [messagesToSummarize, turnPrefixMessages]) {
    for (const message of slice) {
      const content = (message as unknown as { role: string; content: Array<{ text?: string }> });
      if (content.role !== "toolResult") continue;
      assert.match(content.content[0].text ?? "", /上下文已清理/, "两段都得清");
    }
  }
});

test("一轮只清一次：清完再涨回线上，也不再动手", () => {
  // 「这反复清理还不如直接压缩呢」。一条真实会话四十五分钟里清了九次，每次买来
  // 十几分钟，代价是又重写一遍提示词、又打碎一次缓存。清一次就够了，再涨回线上
  // 是 pi 该出手的时候。
  const h = harness(OUR_LINE + 5_000);
  h.context([...history(10), ...recentTail()]);
  assert.equal(h.emitted.length, 1);

  h.setTokens(OUR_LINE + 40_000);
  h.context([...history(10), ...history(10, 40_000, "grep"), ...recentTail()]);
  assert.equal(h.emitted.length, 1, "这一轮的额度已经用掉了");
});

test("压缩没做成，清理的机会也还回来——不然两道闸门一起关死", () => {
  // 真实处境：服务商连着 502，压缩八次重试全废。上下文一点没少，而清理的额度早就
  // 用掉了。这时候再守着「一轮只清一次」，就只剩一路涨到溢出这一条路。
  const h = harness(OUR_LINE + 5_000);
  h.context([...history(10), ...recentTail()]);
  assert.equal(h.emitted.length, 1);

  h.compactionFailed();
  h.context([...history(10), ...history(10, 40_000, "grep"), ...recentTail()]);
  assert.equal(h.emitted.length, 2, "压缩没成，清理得接着顶上");
});

test("用户自己按停的那次，不算机会用掉了也不算还回来", () => {
  const h = harness(OUR_LINE + 5_000);
  h.context([...history(10), ...recentTail()]);
  h.compactionFailed(true);
  h.context([...history(10), ...history(10, 40_000, "grep"), ...recentTail()]);
  assert.equal(h.emitted.length, 1, "人按的停，不该当成压缩失败");
});

test("pi 压缩过一次，就再给一次清理的机会", () => {
  // 压缩之后切点前面变成一段摘要，后面幸存下来的那些工具记录是新一轮的可清对象。
  const h = harness(OUR_LINE + 5_000);
  h.context([...history(10), ...recentTail()]);
  assert.equal(h.emitted.length, 1);

  h.compacted();
  h.context([...history(10), ...history(10, 40_000, "grep"), ...recentTail()]);
  assert.equal(h.emitted.length, 2, "压缩之后该有新的一次机会");

  // 而且只有一次：压缩一次换一次，不是换一个可以反复清的状态。
  h.context([...history(10), ...history(20, 40_000, "grep"), ...recentTail()]);
  assert.equal(h.emitted.length, 2, "一次压缩只换一次清理");
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
