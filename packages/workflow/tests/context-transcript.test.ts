import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import {
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
