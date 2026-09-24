import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import contextClearingExtension from "../extensions/context-clearing.ts";
import contextTranscriptExtension, {
  readSections,
  renderTranscript,
  transcriptNote,
  transcriptPathFor,
  type TranscriptSection,
} from "../extensions/context-transcript.ts";

type AgentMessage = ContextEvent["messages"][number];

function messages(): AgentMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "把 config.json 里的超时改成 30 秒" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "我先看一下这个文件。" },
        { type: "toolCall", id: "c1", name: "read", arguments: { file_path: "/p/config.json" } },
      ],
    },
    { role: "toolResult", toolName: "read", toolCallId: "c1", content: [{ type: "text", text: "{\"timeout\": 5}" }] },
  ] as unknown as AgentMessage[];
}

test("原文渲染成人话，而不是原样的 JSONL", () => {
  // 会话文件是每行一个 JSON、正文还被转义过的东西，让模型直接读那个，
  // 比读原文还费 token——等于压缩了个寂寞。
  const rendered = renderTranscript(messages());
  assert.match(rendered, /## 用户\n把 config\.json 里的超时改成 30 秒/);
  assert.match(rendered, /## 助手\n我先看一下这个文件。/);
  assert.match(rendered, /### 调用 read/);
  assert.match(rendered, /### 结果 read\n\{"timeout": 5\}/);
  assert.doesNotMatch(rendered, /toolCallId/, "内部字段不该泄进正文");
});

test("角色是标题，grep 有下手的地方", () => {
  const rendered = renderTranscript(messages());
  const headings = rendered.split("\n").filter((line) => line.startsWith("#"));
  assert.deepEqual(headings, ["## 用户", "## 助手", "### 调用 read", "### 结果 read"]);
});

test("超长的工具结果会截断，并说清楚原文多长", () => {
  const huge = [{
    role: "toolResult", toolName: "bash", toolCallId: "c1",
    content: [{ type: "text", text: "x".repeat(60_000) }],
  }] as unknown as AgentMessage[];
  const rendered = renderTranscript(huge);
  assert.ok(rendered.length < 25_000, `截断没生效，长度 ${rendered.length}`);
  assert.match(rendered, /原文共 60000 字符/);
});

test("没说话的助手消息不占地方", () => {
  // 只带工具调用、正文为空的那种助手消息，写进去只是噪声。
  const silent = [
    { role: "assistant", content: [{ type: "text", text: "   " }] },
    { role: "user", content: [{ type: "text", text: "继续" }] },
  ] as unknown as AgentMessage[];
  const rendered = renderTranscript(silent);
  assert.doesNotMatch(rendered, /## 助手/);
  assert.match(rendered, /## 用户/);
});

test("认不出来的消息类型不会把整份记录搞崩", () => {
  const odd = [{ role: "什么鬼" }, { role: "user", content: "纯字符串也认" }] as unknown as AgentMessage[];
  const rendered = renderTranscript(odd);
  assert.match(rendered, /## 用户\n纯字符串也认/);
});

test("记录文件跟着会话文件走", () => {
  assert.equal(transcriptPathFor("/s/abc.jsonl"), "/s/abc.transcript.md");
  assert.equal(transcriptPathFor("/s/abc.JSONL"), "/s/abc.transcript.md");
  // 没有后缀也不能把路径搞丢。
  assert.equal(transcriptPathFor("/s/abc"), "/s/abc.transcript.md");
});

test("重开会话时，索引能从文件里读回来", () => {
  // 续上一个会话时内存里的索引是空的，而文件还在。索引忘了之前压过什么，
  // 就等于把模型指向一个文件却不告诉它东西在哪儿。
  const path = join(mkdtempSync(join(tmpdir(), "coilcoil-transcript-")), "s.transcript.md");
  // 第 1 行标记，2–4 行正文；第 5 行标记，6–7 行正文。
  appendFileSync(path, `<!-- coilcoil:compaction ${JSON.stringify({ at: 1_700_000_000_000, messageCount: 4, toLine: 4 })} -->\n`, "utf8");
  appendFileSync(path, "## 用户\n第一段\n\n", "utf8");
  appendFileSync(path, `<!-- coilcoil:compaction ${JSON.stringify({ at: 1_700_000_100_000, messageCount: 7, toLine: 7 })} -->\n`, "utf8");
  appendFileSync(path, "## 用户\n第二段\n", "utf8");

  const sections = readSections(path);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.map((section) => section.fromLine), [1, 5], "行号要落在标记那一行上");
  assert.equal(sections[0]?.messageCount, 4);
  assert.equal(sections[1]?.messageCount, 7);
  assert.ok(sections[1]!.fromLine > sections[0]!.toLine, "第二段应当排在第一段之后");
});

test("文件不存在或者标记写坏了，都当没有索引，不抛异常", () => {
  assert.deepEqual(readSections("/definitely/not/here.transcript.md"), []);
  const path = join(mkdtempSync(join(tmpdir(), "coilcoil-transcript-")), "s.transcript.md");
  appendFileSync(path, "<!-- coilcoil:compaction 这不是 JSON -->\n正文\n", "utf8");
  assert.deepEqual(readSections(path), []);
});

test("给模型的那段话带着路径、行号，和一句别读太多", () => {
  const sections: TranscriptSection[] = [
    { fromLine: 1, toLine: 40, at: 1_700_000_000_000, messageCount: 12 },
    { fromLine: 41, toLine: 90, at: 1_700_000_100_000, messageCount: 8 },
  ];
  const note = transcriptNote("/s/abc.transcript.md", sections) ?? "";
  assert.match(note, /\/s\/abc\.transcript\.md/);
  assert.match(note, /第 1–40 行 · 12 条/);
  assert.match(note, /第 41–90 行 · 8 条/);
  // 能读回来就意味着能把刚腾出来的窗口重新填满，这句提醒是边界的一部分。
  assert.match(note, /按行段取|一次读回太多/);
  assert.match(note, /read|grep/);
  // 这段是给模型查的资料，不是每轮要它做的判断。前一版让它「判断需不需要读」，
  // 于是它每一轮都汇报一次判断结果，把会话刷满了「这次不需要读取压缩对话原文」。
  assert.doesNotMatch(note, /只有在.*才去读/);
  assert.match(note, /不必在回复里交代/);
});

test("这段话进系统提示，不是每轮塞到消息末尾", () => {
  // 挂在 context 上就等于每次请求都追加一条，位置还在最后——那读起来是一条
  // 刚下达的指令，而不是一份资料，模型会逐轮回应它。
  const source = readFileSync(new URL("../extensions/context-transcript.ts", import.meta.url), "utf8");
  assert.match(source, /pi\.on\("before_agent_start"/);
  assert.doesNotMatch(source, /pi\.on\("context"/);
});

test("两个扩展一起跑，存档里留下的必须是原文", () => {
  // 光断言清单顺序不够——真正会出事的是「跑完之后存档里写了什么」。这一条按
  // package.json 的顺序把两个扩展都装上，先准备，再确认压缩成功，最后去
  // 磁盘上读那份存档。2026-09-11 那条会话就是这里塌的：存档 12 万行里 9,815 行是
  // 占位符，模型回头去读，读回来满屏「[上下文已清理]」。
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    pi: { extensions: string[] };
  };
  const order = manifest.pi.extensions.filter((path) => /context-(clearing|transcript)/.test(path));
  const factories: Record<string, (pi: unknown) => void> = {
    "./extensions/context-transcript.ts": contextTranscriptExtension as (pi: unknown) => void,
    "./extensions/context-clearing.ts": contextClearingExtension as (pi: unknown) => void,
  };

  // pi 的 runner 就是这么派发的：按扩展清单的顺序，一个一个 await 过去。
  const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
  const committed: Array<(event: unknown, ctx: unknown) => unknown> = [];
  const sessionFile = join(mkdtempSync(join(tmpdir(), "coilcoil-order-")), "s.jsonl");
  for (const path of order) {
    const pi = {
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
        if (event === "session_before_compact") handlers.push(handler);
        if (event === "session_compact") committed.push(handler);
      },
      events: { emit: () => {} },
    };
    factories[path](pi);
  }

  const realArgs = { path: "/src/config.json", purpose: "看超时配置" };
  const messagesToSummarize: AgentMessage[] = [
    { role: "assistant", content: [{ type: "toolCall", id: "call_0", name: "read", arguments: realArgs }], timestamp: 1 },
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "call_0",
      content: [{ type: "text", text: "x".repeat(60_000) }],
      timestamp: 2,
    },
  ] as unknown as AgentMessage[];
  const ctx = {
    sessionManager: { getSessionFile: () => sessionFile },
    getContextUsage: () => ({ tokens: 0, contextWindow: 200_000, percent: 0 }),
  };
  for (const handler of handlers) {
    handler({ preparation: { messagesToSummarize, turnPrefixMessages: [] } }, ctx);
  }
  assert.equal(existsSync(transcriptPathFor(sessionFile)), false, "压缩成功前不可落盘");
  for (const handler of committed) handler({}, ctx);

  // 交给 pi 去摘要的那一份，工具内容该清掉——这是另一个 bug 的修复，不能倒回去。
  const summarized = messagesToSummarize[1] as unknown as { content: Array<{ text: string }> };
  assert.match(summarized.content[0].text, /上下文已清理/, "摘要那一份还是要瘦");

  // 而存档里必须是原文，一个字不少。
  const archive = readFileSync(transcriptPathFor(sessionFile), "utf8");
  assert.match(archive, /\/src\/config\.json/, "存档里要看得见真实参数");
  assert.match(archive, /看超时配置/);
  assert.ok(archive.includes("x".repeat(20_000)), "存档里要看得见真实输出");
  assert.doesNotMatch(archive, /上下文已清理/, "存档里一个占位符都不该有");
});

test("自动压缩取消或失败时不留下假存档", () => {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  contextTranscriptExtension({ on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
  } } as never);
  const sessionFile = join(mkdtempSync(join(tmpdir(), "coilcoil-cancel-")), "s.jsonl");
  const ctx = { sessionManager: { getSessionFile: () => sessionFile } };
  const before = handlers.get("session_before_compact")![0];
  before({ preparation: { messagesToSummarize: messages() } }, ctx);
  assert.equal(existsSync(transcriptPathFor(sessionFile)), false);
  handlers.get("session_compact_failed")![0]({ aborted: true }, ctx);
  handlers.get("session_compact")![0]({}, ctx);
  assert.equal(existsSync(transcriptPathFor(sessionFile)), false, "取消后不能把暂存内容写进去");
});

test("存档扩展必须排在清理扩展前面", () => {
  // 两个扩展挂的是同一个 session_before_compact，拿到的是同一个
  // preparation.messagesToSummarize 数组，而清理那一层是就地改写它的。排在后面，
  // 这里暂存的就是清理后的那一份——而存档的全部意义正是「压缩丢掉的东西还能翻
  // 回来」。2026-09-11 那条会话的存档 12 万行里有 9,815 行是占位符，模型回头去读存
  // 档，读回来满屏「[上下文已清理]」。package.json 里的顺序就是执行顺序。
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    pi: { extensions: string[] };
  };
  const order = manifest.pi.extensions;
  const transcript = order.indexOf("./extensions/context-transcript.ts");
  const clearing = order.indexOf("./extensions/context-clearing.ts");
  assert.ok(transcript >= 0 && clearing >= 0, "两个扩展都得在清单里");
  assert.ok(transcript < clearing, "存档要先暂存没被清理过的原文");
});

test("还没压缩过就什么也不说", () => {
  // 一个字都不该占：绝大多数会话从头到尾都用不到这段话。
  assert.equal(transcriptNote("/s/abc.transcript.md", []), undefined);
});

test("记录是追加的，行号一旦给出去就不会变", () => {
  const path = join(mkdtempSync(join(tmpdir(), "coilcoil-transcript-")), "s.transcript.md");
  appendFileSync(path, `<!-- coilcoil:compaction ${JSON.stringify({ at: 1, messageCount: 1, toLine: 3 })} -->\n第一段\n\n`, "utf8");
  const before = readFileSync(path, "utf8");
  appendFileSync(path, `<!-- coilcoil:compaction ${JSON.stringify({ at: 2, messageCount: 1, toLine: 6 })} -->\n第二段\n`, "utf8");
  assert.ok(readFileSync(path, "utf8").startsWith(before), "旧内容被改动了，之前给出去的行号就失效了");
  assert.equal(readSections(path)[0]?.fromLine, 1);
});
