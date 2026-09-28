import assert from "node:assert/strict";
import test from "node:test";
import compactionExtension, { COMPACTION_EVENT, keptTokens, mergedFileOps, planLayer1 } from "../extensions/compaction.ts";
import { isInputOverflow } from "../extensions/compaction/request.ts";
import { InputTooLongError, summarize, type SummaryRequest } from "../extensions/compaction/summarize.ts";
import {
  chunkUnits,
  cleanedBody,
  composeCleaned,
  estimateTextTokens,
  renderCleaned,
  renderForSummary,
  type LlmMessage,
} from "../extensions/compaction/text.ts";

const bigCode = "const x = 1;\n".repeat(400);

function conversation(): LlmMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "把 config.json 里的超时改成 30 秒" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "用户想改超时，我先读文件。".repeat(200) },
        { type: "text", text: "我先看一下配置。" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "config.json" } },
      ],
    },
    { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "{\"timeout\": 10}".repeat(300) }] },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c2", name: "write", arguments: { path: "config.json", content: bigCode } }],
    },
    { role: "toolResult", toolCallId: "c2", toolName: "write", isError: true, content: [{ type: "text", text: "EACCES: permission denied, open 'config.json'" }] },
    { role: "assistant", content: [{ type: "text", text: "没有写权限，改成先 chmod 再写。" }] },
  ];
}

test("中文一个字按一个 token 算，英文四个字符一个", () => {
  assert.equal(estimateTextTokens("你好世界"), 4);
  assert.equal(estimateTextTokens("abcdefgh"), 2);
  assert.equal(estimateTextTokens("改 a.ts"), 1 + 2);
});

test("第 1 层整理稿：原话一字不动，思考删掉，工具只留一行痕迹，报错留开头", () => {
  const text = renderCleaned(conversation());
  assert.ok(text.includes("【用户】把 config.json 里的超时改成 30 秒"));
  assert.ok(text.includes("【助手】我先看一下配置。"));
  assert.ok(text.includes("【助手】没有写权限，改成先 chmod 再写。"));
  assert.ok(!text.includes("用户想改超时"), "思考过程应删掉");
  assert.ok(text.includes("【工具】read(path=config.json)"));
  assert.ok(/【工具】write\(path=config.json, content=const x = 1;[\s\S]*?…（共 \d+ 字）\)/.test(text), "大段参数只留开头和总长");
  assert.ok(text.includes("→ 结果已省略（"), "工具结果只留长度");
  assert.ok(text.includes("→ 出错：EACCES: permission denied"), "报错留开头");
  assert.ok(text.length < 2000, `整理稿应当很短，实际 ${text.length}`);
});

test("第 2 层材料：思考删掉，工具调用和结果都留，长结果只留头尾", () => {
  const units = renderForSummary(conversation());
  const all = units.join("\n");
  assert.ok(!all.includes("用户想改超时"));
  assert.ok(all.includes("【工具调用】read(path=config.json)"));
  assert.ok(all.includes("【工具结果·read】{\"timeout\": 10}"));
  assert.ok(all.includes("中间省略"), "长结果留头尾");
  assert.ok(all.includes("【工具结果·出错·write】EACCES"));
});

test("整理稿可以叠加：认得出上一份，正文接上，文件清单不重复", () => {
  const first = composeCleaned({ cleaned: "【用户】第一段", files: "## 涉及的文件\n改过的文件：\n- a.ts" });
  const body = cleanedBody(first);
  assert.equal(body, "【用户】第一段");
  const second = composeCleaned({ previousBody: body, cleaned: "【用户】第二段", files: "## 涉及的文件\n改过的文件：\n- a.ts\n- b.ts" });
  assert.equal(second.match(/## 涉及的文件/g)?.length, 1);
  assert.ok(second.indexOf("第一段") < second.indexOf("第二段"));
  assert.equal(cleanedBody("## 目标\n普通摘要"), undefined, "模型写的摘要不是整理稿");
});

test("第 1 层只有压完 ≤ 窗口 35% 才采用", () => {
  const base = { messages: conversation(), files: "", overheadTokens: 10_000 };
  const small = planLayer1({ ...base, keptTokens: 20_000, contextWindow: 200_000 });
  assert.equal(small.targetTokens, 70_000);
  assert.ok(small.accept, `应采用，估计 ${small.estimatedAfter}`);
  const tight = planLayer1({ ...base, keptTokens: 60_000, contextWindow: 200_000 });
  assert.ok(!tight.accept, "保留区太大，压完超过 35%，应走第 2 层");
  const previous = composeCleaned({ cleaned: "【用户】很早的事".repeat(20_000), files: "" });
  const accumulated = planLayer1({ ...base, previousSummary: previous, keptTokens: 20_000, contextWindow: 200_000 });
  assert.ok(!accumulated.accept, "整理稿越积越多、单靠第 1 层压不下去时，自然升级到第 2 层");
});

test("按预算切块，单条超大的按字切开", () => {
  const chunks = chunkUnits(["短".repeat(100), "长".repeat(5000), "短".repeat(100)], 1000);
  assert.ok(chunks.length >= 5, `应切成多块，实际 ${chunks.length}`);
  for (const chunk of chunks) assert.ok(estimateTextTokens(chunk) <= 1000);
});

function fakeRequest(options: { tooLong?: (request: SummaryRequest) => boolean } = {}) {
  const calls: SummaryRequest[] = [];
  const request = async (req: SummaryRequest) => {
    calls.push(req);
    if (options.tooLong?.(req)) throw new InputTooLongError("The input is longer than the model's context length");
    return { text: `摘要(${req.label})`, inputTokens: 10, outputTokens: 5 };
  };
  return { calls, request };
}

test("第 2 层：装得下就一次写完，并在上一份摘要基础上更新", async () => {
  const { calls, request } = fakeRequest();
  const result = await summarize({ units: ["【用户】改超时", "【助手】好"], previousSummary: "## 目标\n旧目标", contextWindow: 200_000, modelMaxTokens: 32_000, request });
  assert.equal(result.chunks, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].prompt.includes("<上一份摘要>"));
  assert.ok(calls[0].prompt.includes("## 进行中"));
});

test("第 2 层：装不下就分块同时写，再合并成一份", async () => {
  const { calls, request } = fakeRequest();
  const units = Array.from({ length: 40 }, (_, index) => `【用户】第 ${index} 条 ${"内容".repeat(1500)}`);
  const result = await summarize({ units, contextWindow: 32_000, modelMaxTokens: 8000, request, concurrency: 3 });
  assert.ok(result.chunks > 1, `应分块，实际 ${result.chunks}`);
  const parts = calls.filter((call) => call.label.startsWith("第 "));
  const merges = calls.filter((call) => call.label.includes("合并"));
  assert.equal(parts.length, result.chunks);
  assert.ok(merges.length >= 1);
  assert.ok(result.text.startsWith("摘要(合并"));
});

test("第 2 层：某一块模型说太长，就把这块对半切开重来", async () => {
  let refused = 0;
  let refusedLabel = "";
  const { calls, request } = fakeRequest({ tooLong: (req) => {
    if (refused || !req.label.startsWith("第 1/")) return false;
    refused++;
    refusedLabel = req.label;
    return true;
  } });
  const units = Array.from({ length: 40 }, (_, index) => `【用户】第 ${index} 条 ${"内容".repeat(1500)}`);
  const result = await summarize({ units, contextWindow: 120_000, modelMaxTokens: 8000, request });
  assert.equal(refused, 1);
  assert.equal(calls.filter((call) => call.label === refusedLabel).length, 3, "被拒一次，拆成两半各写一次");
  assert.ok(result.text.startsWith("摘要(合并"));
});

test("认得出各家「输入太长」的报错", () => {
  assert.ok(isInputOverflow("400: The input is longer than the model's context length"));
  assert.ok(isInputOverflow("prompt is too long: 250000 tokens > 200000 maximum"));
  assert.ok(isInputOverflow("This model's maximum context length is 128000 tokens"));
  assert.ok(!isInputOverflow("Request timed out."));
  assert.ok(!isInputOverflow("429 rate limit"));
});

// ---- 扩展本身：用假的 Pi 接口走一遍 ----

interface Handler { (event: unknown, ctx: unknown): Promise<unknown> }

function harness() {
  const handlers = new Map<string, Handler>();
  const events: Array<Record<string, unknown>> = [];
  const pi = {
    on: (name: string, handler: Handler) => { handlers.set(name, handler); },
    events: { emit: (channel: string, data: unknown) => { if (channel === COMPACTION_EVENT) events.push(data as Record<string, unknown>); } },
    getActiveTools: () => ["read"],
    getAllTools: () => [{ name: "read", description: "读文件", parameters: { type: "object" } }],
  };
  compactionExtension(pi as never);
  const ctx = (window: number, authOk = true) => ({
    model: { provider: "p", id: "m", contextWindow: window, maxTokens: 8000, reasoning: false, api: "openai-completions" },
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => authOk ? { ok: true, apiKey: "k" } : { ok: false, error: "没有配置密钥" },
    },
    sessionManager: { getSessionFile: () => "/tmp/s.jsonl" },
    getSystemPrompt: () => "系统提示",
  });
  return { handler: handlers.get("session_before_compact")!, events, ctx };
}

function compactEvent(messages: LlmMessage[], reason = "threshold") {
  return {
    type: "session_before_compact",
    reason,
    willRetry: false,
    signal: new AbortController().signal,
    branchEntries: [
      { type: "message", id: "a", parentId: null, message: messages[0] },
      { type: "message", id: "kept", parentId: "a", message: { role: "user", content: [{ type: "text", text: "最近的一句" }] } },
    ],
    preparation: {
      firstKeptEntryId: "kept",
      messagesToSummarize: messages,
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 150_000,
      fileOps: { read: new Set(["config.json"]), written: new Set(["config.json"]), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    },
  };
}

test("扩展：清完够小就停在第 1 层，不调模型", async () => {
  const { handler, events, ctx } = harness();
  const result = await handler(compactEvent(conversation()), ctx(200_000)) as { compaction: { summary: string; firstKeptEntryId: string; details: { coilcoil: { layer: number }; modifiedFiles: string[] } } };
  assert.equal(result.compaction.details.coilcoil.layer, 1);
  assert.equal(result.compaction.firstKeptEntryId, "kept");
  assert.ok(result.compaction.summary.includes("【用户】把 config.json 里的超时改成 30 秒"));
  assert.ok(result.compaction.summary.includes("- config.json"), "附上改过的文件");
  assert.deepEqual(result.compaction.details.modifiedFiles, ["config.json"]);
  assert.ok(events.some((event) => event.phase === "done" && event.layer === 1));
});

test("扩展：第 2 层失败时明确取消（会话保持原样），不交回空结果让 Pi 拿原始历史再压", async () => {
  const { handler, events, ctx } = harness();
  // 对话较长、窗口很小：第 1 层压不到 35%，走第 2 层；密钥没配，第 2 层失败。
  const long = [{ role: "user", content: [{ type: "text", text: "需求说明".repeat(1500) }] }, ...conversation()];
  const result = await handler(compactEvent(long), ctx(8_000, false));
  assert.deepEqual(result, { cancel: true });
  const failed = events.find((event) => event.phase === "failed");
  assert.ok(failed && String(failed.error).includes("没有配置密钥"));
  // 同一处刚失败过：自动压缩十分钟内不再重试，直接取消。
  const again = await handler(compactEvent(long), ctx(8_000, false));
  assert.deepEqual(again, { cancel: true });
  assert.ok(events.some((event) => event.phase === "skipped"));
});

test("保留区大小按原样发送的量算；文件清单接上上一次压缩记下的", () => {
  const branch = [
    { type: "compaction", id: "c", parentId: null, summary: "", firstKeptEntryId: "x", tokensBefore: 1, details: { readFiles: ["old.ts"], modifiedFiles: ["gone.ts"] } },
    { type: "message", id: "k", parentId: "c", message: { role: "user", content: [{ type: "text", text: "你好你好" }] } },
  ];
  assert.equal(keptTokens(branch as never, "k"), 4 + 4);
  const merged = mergedFileOps({ read: new Set(["new.ts"]), written: new Set<string>(), edited: new Set<string>() }, branch as never);
  assert.deepEqual([...merged.read].sort(), ["new.ts", "old.ts"]);
  assert.deepEqual([...merged.edited], ["gone.ts"]);
});
