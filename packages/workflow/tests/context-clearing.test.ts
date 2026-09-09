import assert from "node:assert/strict";
import test from "node:test";
import {
  applyToolResultClearing,
  clearingThreshold,
  planToolResultClearing,
} from "../extensions/context-clearing.ts";

type AgentMessage = Parameters<typeof planToolResultClearing>[0][number];

const CONTEXT_WINDOW = 200_000;
/** Past the point where clearing is the first stage of an imminent compaction. */
const FULL = { tokens: 175_000, contextWindow: CONTEXT_WINDOW };

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

test("最近这一段对话原封不动，动的只有它前面的", () => {
  // 每条结果 40,000 字符 ≈ 10,000 token，保护额度 50,000，所以最新 5 条一定
  // 安全；不足 8 条时由下限兜底。总之最新的那几条必须一条都不动。
  const plan = planToolResultClearing(conversation(30), new Set(), FULL);
  const cleared = new Set(plan.toolCallIds);
  for (let index = 25; index < 30; index++) {
    assert.equal(cleared.has(`call-${index}`), false, `call-${index} 在受保护的那一段里`);
  }
  assert.equal(cleared.has("call-0"), true, "最老的那条就是要清的");
  assert.ok(cleared.size > 0 && cleared.size < 30);
});

test("保护范围按 token 算，不是按条数", () => {
  // 条数不是跨度：用户真实会话里每轮工具调用的中位数是 13，一半的轮次超过
  // 12 条。按「最新 12 条」保护，就等于一半的时间里模型正在做的这一轮，
  // 自己前面的输出被删掉了。
  const small = planToolResultClearing(conversation(40, 1_600), new Set(), FULL);
  const large = planToolResultClearing(conversation(40, 40_000), new Set(), FULL);
  const keptSmall = 40 - small.toolCallIds.length;
  const keptLarge = 40 - large.toolCallIds.length;
  assert.ok(keptSmall > keptLarge,
    `结果越小，同样的 token 额度应当保住越多条（小 ${keptSmall} 条 vs 大 ${keptLarge} 条）`);
});

test("腾不出多少就干脆不动手", () => {
  // 十三条 4k 字符的读取加起来也远不到窗口的 5%，清了只是白打断缓存。
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

test("清理是压缩的第一级，只在压缩线附近才动手", () => {
  // 这一层原来从半满就开始清，还每 8000 token 补一次。拿真实会话模拟，
  // 一个会话里触发 289 次——平均每 16 次工具调用一次，而那时候窗口还空着
  // 一半。删得早没有任何好处，只是让工具结果更早消失。
  const results = Array.from({ length: 20 }, (_, index) => [
    toolCall(`c${index}`, "read"),
    toolResult(`c${index}`, "read", 40_000),
  ]).flat();

  const half = planToolResultClearing(results, new Set(), { tokens: 100_000, contextWindow: CONTEXT_WINDOW });
  assert.deepEqual(half.toolCallIds, [], "半满时一条都不该清");
  const threeQuarters = planToolResultClearing(results, new Set(), { tokens: 150_000, contextWindow: CONTEXT_WINDOW });
  assert.deepEqual(threeQuarters.toolCallIds, [], "四分之三满也还早");
  assert.ok(planToolResultClearing(results, new Set(), FULL).toolCallIds.length > 0, "逼近压缩线才动手");
});

test("动手的时候一次清干净，而不是每次挤一点", () => {
  const messages = conversation(20);
  const first = planToolResultClearing(messages, new Set(), FULL);
  // 一次就把当时所有够格的都清掉；再问一次，没有新的可清。
  const again = planToolResultClearing(messages, new Set(first.toolCallIds), FULL);
  assert.ok(first.toolCallIds.length > 1, "一批不能只清一条");
  assert.deepEqual(again.toolCallIds, [], "同样的输入不该还剩下可清的");
});

test("清理线必须赶在 Pi 决定摘要之前", () => {
  // Pi 用上一次响应的用量判断要不要压缩，而清理只影响下一次请求。两条线重合
  // 的话，每次都是 Pi 先赢，这一级永远轮不到。
  for (const window of [200_000, 1_050_000]) {
    assert.ok(clearingThreshold(window) < window - 16_384, `窗口 ${window} 的清理线没有留出余量`);
  }
  // 小模型上两条线会挤在一起，这时宁可不清，也不要一开局就删。
  assert.ok(clearingThreshold(32_000) >= 16_000);
});

test("一批能腾出的量按窗口比例算，不是固定 8000", () => {
  // 固定阈值在 200k 上是 4%，在 1M 上只有 0.8%——同一个数字在两种模型上
  // 说的不是同一件事。
  const results = Array.from({ length: 20 }, (_, index) => [
    toolCall(`c${index}`, "read"),
    toolResult(`c${index}`, "read", 3_000),
  ]).flat();
  // 8 条 × 750 token = 6000，够不上 200k 的 5%（10000）。
  assert.deepEqual(planToolResultClearing(results, new Set(), FULL).toolCallIds, []);
});
