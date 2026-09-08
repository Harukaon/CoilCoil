import assert from "node:assert/strict";
import test from "node:test";
import type { ToolRun } from "@coilcoil/runtime-protocol";
import {
  beginStreamingToolRun,
  partialJsonStrings,
  streamingToolCall,
} from "../src/streaming-tool-call.js";
import { ToolRunIds } from "../src/tool-run-ids.js";

function update(partialJson: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    type: "toolcall_delta",
    contentIndex: 1,
    partial: {
      content: [
        { type: "text", text: "先说两句" },
        { type: "toolCall", id: "call-1", name: "edit", arguments: {}, partialJson, ...overrides },
      ],
    },
  };
}

function target() {
  return { tools: new Map<string, ToolRun>(), toolRunIds: new ToolRunIds(), nextTimelineOrder: 7 };
}

test("参数才流到一半，路径也已经能读出来", () => {
  // edit 的 path 是第一个键，所以卡片一开始就能说清在改哪个文件。
  assert.deepEqual(partialJsonStrings('{"path": "src/a.ts", "edits": [{"oldText": "旧'), { path: "src/a.ts" });
});

test("只读完整的字符串，读到一半的不要", () => {
  // 半截路径要是也认，标签会一个字一个字地抖过去。
  assert.deepEqual(partialJsonStrings('{"path": "src/a'), {});
  assert.deepEqual(partialJsonStrings('{"path"'), {});
  assert.deepEqual(partialJsonStrings(""), {});
});

test("嵌套里的键不会被当成顶层参数", () => {
  // edit 把替换内容放在 edits[] 里；把里面的 oldText 提上来，
  // 卡片标题就会变成被编辑文件的一个片段。
  const found = partialJsonStrings('{"path": "a.ts", "edits": [{"oldText": "path", "newText": "x"}]}');
  assert.deepEqual(found, { path: "a.ts" });
});

test("转义字符不会把字符串提前截断", () => {
  const found = partialJsonStrings('{"command": "echo \\"hi\\" && ls", "path": "b.ts"}');
  assert.equal(found.command, 'echo "hi" && ls');
  assert.equal(found.path, "b.ts");
});

test("从流式事件里认出是哪个工具", () => {
  const call = streamingToolCall(update('{"path": "src/a.ts"'));
  assert.deepEqual(call, { id: "call-1", name: "edit", args: { path: "src/a.ts" } });
});

test("没有 id 或名字就先不画，宁可晚一点也不要画错", () => {
  assert.equal(streamingToolCall(update("{", { id: "" })), undefined);
  assert.equal(streamingToolCall(update("{", { name: "" })), undefined);
  assert.equal(streamingToolCall({ type: "toolcall_start", contentIndex: 9, partial: { content: [] } }), undefined);
  assert.equal(streamingToolCall(undefined), undefined);
});

test("有些提供方直接给解析好的参数，也要认", () => {
  const call = streamingToolCall({
    type: "toolcall_start",
    contentIndex: 0,
    partial: { content: [{ type: "toolCall", id: "c", name: "read", arguments: { path: "x.ts" } }] },
  });
  assert.deepEqual(call?.args, { path: "x.ts" });
});

test("第一次是 tool_started，卡片带着文件名和转圈", () => {
  const state = target();
  const event = beginStreamingToolRun(state, update('{"path": "src/a.ts"'), (name, args) =>
    `编辑 ${String(args.path ?? "文件")}（${name}）`);
  assert.equal(event?.type, "tool_started");
  const tool = state.tools.get([...state.tools.keys()][0])!;
  assert.equal(tool.status, "running", "running 才有转圈，复用的就是这个样式");
  assert.equal(tool.label, "编辑 src/a.ts（edit）");
  assert.equal(tool.order, 7);
});

test("路径后到的时候补一条 tool_updated，而不是再开一张卡", () => {
  const state = target();
  const first = beginStreamingToolRun(state, update("{"), (name) => `调用 ${name}`);
  assert.equal(first?.type, "tool_started");
  const second = beginStreamingToolRun(state, update('{"path": "src/a.ts"'), (_name, args) =>
    `编辑 ${String(args.path ?? "文件")}`);
  assert.equal(second?.type, "tool_updated");
  assert.equal(state.tools.size, 1, "必须是同一张卡，不能开第二张");
  assert.equal(state.nextTimelineOrder, 8, "第二次不该再占一个位置");
});

test("参数一直流但标签没变，就不再重复发事件", () => {
  // 一次大 edit 有成百上千个 delta，每个都重画一次行是纯浪费。
  const state = target();
  beginStreamingToolRun(state, update('{"path": "a.ts"'), () => "编辑 a.ts");
  const again = beginStreamingToolRun(state, update('{"path": "a.ts", "edits": [{"oldText": "x"'), () => "编辑 a.ts");
  assert.equal(again, undefined);
});

test("已经结束的卡片，不会被迟到的增量拽回运行中", () => {
  const state = target();
  const started = beginStreamingToolRun(state, update("{"), () => "编辑");
  assert.equal(started?.type, "tool_started");
  const id = [...state.tools.keys()][0];
  state.tools.set(id, { ...state.tools.get(id)!, status: "succeeded", endedAt: Date.now() });
  assert.equal(beginStreamingToolRun(state, update('{"path": "a.ts"'), () => "编辑 a.ts"), undefined);
  assert.equal(state.tools.get(id)?.status, "succeeded");
});

test("流式先建的卡，和真正执行时是同一个运行 id", () => {
  // 这条错了就会出现两张卡：一张一直转圈，一张才是真的。
  const state = target();
  beginStreamingToolRun(state, update('{"path": "a.ts"'), () => "编辑 a.ts");
  assert.equal(state.toolRunIds.begin("call-1"), [...state.tools.keys()][0]);
});
