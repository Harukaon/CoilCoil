import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, RuntimeSummaryEvent, ToolRun } from "@coilcoil/runtime-protocol";
import {
  buildCompactionMarks,
  compactionMarkDetail,
  compactionMarkLabel,
  compactionSummaryPreview,
  COMPACTION_SUMMARY_PREVIEW_CHARS,
} from "../src/renderer/src/features/conversation/compactionMarks.ts";
import { buildConversationTimeline } from "../src/renderer/src/features/conversation/buildConversationTimeline.ts";

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m1",
    order: 1,
    role: "user",
    text: "问",
    timestamp: 1_000,
    ...overrides,
  };
}

function compaction(overrides: Partial<RuntimeSummaryEvent>): RuntimeSummaryEvent {
  return {
    id: "c1",
    kind: "compaction",
    status: "succeeded",
    timestamp: 2_000,
    active: true,
    ...overrides,
  };
}

const messages = [
  message({ id: "a", entryId: "e-a", order: 1, timestamp: 1_000 }),
  message({ id: "b", entryId: "e-b", order: 2, timestamp: 2_000, role: "assistant", text: "答" }),
  message({ id: "c", entryId: "e-c", order: 3, timestamp: 3_000 }),
];

test("压缩的横线落在它保留的第一条消息前面", () => {
  const marks = buildCompactionMarks(messages, [compaction({ firstKeptEntryId: "e-c" })]);
  assert.equal(marks.length, 1);
  assert.ok(marks[0].order > 2 && marks[0].order < 3, "应该夹在第二条和第三条之间");
  assert.equal(marks[0].layer, 2);
});

test("认不出保留点时退回按时间放，说法也跟着改", () => {
  // 老会话没有 firstKeptEntryId，横线还是得有个合理的位置——但这时线的位置只代表
  // 「压缩发生在这一刻」，不代表切分点，所以那句话不能说「这条线以上都折叠了」：
  // 保留下来的最近几万 token 原文，恰恰就在线的上面。
  const marks = buildCompactionMarks(messages, [compaction({ timestamp: 2_500 })]);
  assert.ok(marks[0].order > 2 && marks[0].order < 3);
  assert.equal(marks[0].atCutPoint, false);
  const detail = compactionMarkDetail(marks[0]);
  assert.doesNotMatch(detail, /这条线以上/);
  assert.match(detail, /较早的对话/);
});

test("落在切分点上时，才说得出「这条线以上」", () => {
  const marks = buildCompactionMarks(messages, [compaction({ firstKeptEntryId: "e-c" })]);
  assert.equal(marks[0].atCutPoint, true);
  const detail = compactionMarkDetail(marks[0]);
  assert.match(detail, /这条线以上/);
  assert.match(detail, /线以下的原文照常/, "线下面那一段是原样发给模型的，得说清楚");
});

test("别的分支上的压缩不画进这条对话", () => {
  // 被放弃的分支上那次压缩，概括的是这条对话从来没有过的消息。
  assert.deepEqual(buildCompactionMarks(messages, [compaction({ active: false })]), []);
});

test("清理工具输出是第一层，自己单独一条线", () => {
  const marks = buildCompactionMarks(messages, [], [{ at: 2_500, clearedResults: 7, freedTokens: 9_100 }]);
  assert.equal(marks[0].layer, 1);
  assert.equal(marks[0].clearedResults, 7);
  assert.equal(compactionMarkLabel(marks[0]), "已清理 7 条工具记录");
  assert.match(compactionMarkDetail(marks[0]), /7 条工具调用/);
  assert.match(compactionMarkDetail(marks[0]), /9,100/);
  assert.match(compactionMarkDetail(marks[0]), /调过哪些工具还看得见/);
});

test("两层的线按先后排好，不会互相盖住", () => {
  const marks = buildCompactionMarks(
    messages,
    [compaction({ id: "late", firstKeptEntryId: "e-c" })],
    [{ at: 1_200, clearedResults: 3, freedTokens: 8_000 }],
  );
  assert.deepEqual(marks.map((mark) => mark.layer), [1, 2]);
  assert.ok(marks[0].order < marks[1].order);
});

test("正在压缩时线上就说正在压缩", () => {
  const marks = buildCompactionMarks(messages, [compaction({ status: "running" })]);
  assert.equal(marks[0].status, "running");
  assert.equal(compactionMarkLabel(marks[0]), "正在整理上下文…");
  const failed = buildCompactionMarks(messages, [compaction({ status: "failed" })]);
  assert.equal(compactionMarkLabel(failed[0]), "上下文整理失败");
});

test("第二层显示压缩前后的大小和一段摘要，但不整段贴回来", () => {
  const marks = buildCompactionMarks(messages, [compaction({
    firstKeptEntryId: "e-c",
    tokensBefore: 180_000,
    estimatedTokensAfter: 42_000,
    summary: "长".repeat(2_000),
  })]);
  const detail = compactionMarkDetail(marks[0]);
  assert.match(detail, /180,000/);
  assert.match(detail, /42,000/);
  const preview = compactionSummaryPreview(marks[0].summary);
  assert.equal(Array.from(preview ?? "").length, COMPACTION_SUMMARY_PREVIEW_CHARS + 1, "超长摘要要截断并加省略号");
  assert.equal(compactionSummaryPreview(undefined), undefined);
  assert.equal(compactionSummaryPreview("   "), undefined);
});

test("横线在时间线里是独立一段，不会被塞进某一轮回复", () => {
  const timeline = buildConversationTimeline([...messages], [], [], undefined, { summaryEvents: [compaction({ firstKeptEntryId: "e-c" })] });
  const kinds = timeline.map((item) => item.kind);
  assert.deepEqual(kinds, ["user", "agent", "compaction", "user"]);
});

test("压缩还在跑的时候，它之前跑完的命令不能被甩到线下面", () => {
  // 用户的原话：「怎么可能会有模型继续在运行命令呢」。压缩期间模型不干活，所以
  // 线下面出现一条命令只有一种解释——那条命令是压缩之前跑的，被放错了地方。
  // 根子在工具调用和消息共用一套序号，而横线只对着消息放：压缩还在跑，后面还没
  // 有新消息，横线就落到「最后一条消息之后」，而那之后的工具序号更大。
  const said: ChatMessage[] = [
    { id: "m1", entryId: "e1", role: "user", text: "改一下", order: 1, timestamp: 1 },
    { id: "m2", entryId: "e2", role: "assistant", text: "先看表结构", order: 2, timestamp: 2 },
  ] as unknown as ChatMessage[];
  const ran = [{
    id: "t1", order: 3, name: "bash", label: "运行了 1 个命令", args: {}, output: "",
    status: "succeeded", startedAt: 3, endedAt: 4,
  }] as unknown as ToolRun[];

  const timeline = buildConversationTimeline(said, ran, [], undefined, {
    summaryEvents: [compaction({ status: "running", timestamp: 5 })],
  });
  assert.deepEqual(timeline.map((item) => item.kind), ["user", "agent", "compaction"], "线该在最后面");
  const agent = timeline[1];
  assert.equal(agent.kind === "agent" && agent.items.some((item) => item.kind === "tools"), true, "命令留在线上面");
});

test("横线落在一段回答中间时，下半截不再报一遍模型名", () => {
  // 用户截图里的样子：一段回答说到一半，横线画下来，紧接着又出现一行
  // 「Claude Opus 5」，看上去像模型重新答了一遍。线还是要画在它发生的地方，但线
  // 下面那半截是同一轮在接着说。
  const turn: ChatMessage[] = [
    { id: "m1", entryId: "e1", role: "user", text: "帮我看看", order: 1, timestamp: 1 },
    { id: "m2", entryId: "e2", role: "assistant", text: "先看表结构", order: 2, timestamp: 2 },
    { id: "m3", entryId: "e3", role: "assistant", text: "改好了", order: 3, timestamp: 4 },
  ] as unknown as ChatMessage[];
  const timeline = buildConversationTimeline(turn, [], [], undefined, {
    summaryEvents: [],
    contextClearings: [{ at: 3, clearedResults: 5, freedTokens: 9_000 }],
  });
  assert.deepEqual(timeline.map((item) => item.kind), ["user", "agent", "compaction", "agent"]);
  const [, first, , second] = timeline;
  assert.equal(first.kind === "agent" && first.continuation, undefined, "上半截照常报模型名");
  assert.equal(second.kind === "agent" && second.continuation, true, "下半截是接着说，不是新的一轮");
});

test("用户插话之后的那一轮，还是要报模型名", () => {
  // 线后面确实开了新的一轮：这时候模型名该出现，不能被上一条的修法顺手吞掉。
  const talk: ChatMessage[] = [
    { id: "m1", entryId: "e1", role: "assistant", text: "好了", order: 1, timestamp: 1 },
    { id: "m2", entryId: "e2", role: "user", text: "再来一次", order: 2, timestamp: 4 },
    { id: "m3", entryId: "e3", role: "assistant", text: "这就来", order: 3, timestamp: 5 },
  ] as unknown as ChatMessage[];
  const timeline = buildConversationTimeline(talk, [], [], undefined, {
    summaryEvents: [],
    contextClearings: [{ at: 3, clearedResults: 5, freedTokens: 9_000 }],
  });
  const last = timeline.at(-1)!;
  assert.equal(last.kind === "agent" && last.continuation, undefined);
});

test("压缩失败时，线上说得出为什么失败", () => {
  // 「失败为啥我看不到报错？」——运行时一直有这句话，它写进日志、闪过一个几秒钟
  // 的提示，而留在屏幕上的那道线只说「上下文整理失败」。原因是用户唯一能据此行动
  // 的东西，必须留在线上。
  const marks = buildCompactionMarks(messages, [compaction({
    status: "failed",
    error: "Summarization failed: 502 Upstream request failed",
  })]);
  const detail = compactionMarkDetail(marks[0]);
  assert.match(detail, /502 Upstream request failed/);
  assert.match(detail, /没做成/);
  assert.doesNotMatch(detail, /折叠成一段摘要发给模型/, "没压成就不能说压成了");
  assert.match(detail, /compact/, "得告诉用户现在能做什么");

  const retrying = buildCompactionMarks(messages, [compaction({ status: "failed", error: "502", willRetry: true })]);
  assert.match(compactionMarkDetail(retrying[0]), /自己再试/);
});

test("落在同一处的几条共用一道线，不画成两道", () => {
  // 清理刚跑完、压缩紧接着失败，在长会话里是常态。各画一道线，读起来就是两道挨着
  // 的横线在打架，而它们说的是同一个位置上发生的事。
  const timeline = buildConversationTimeline([...messages], [], [], undefined, {
    summaryEvents: [compaction({ status: "failed", error: "502", timestamp: 3_000 })],
    contextClearings: [{ at: 3_000, clearedResults: 4, freedTokens: 9_000 }],
  });
  const marks = timeline.filter((item) => item.kind === "compaction");
  assert.equal(marks.length, 1, "只该有一道线");
  assert.equal(marks[0].kind === "compaction" && marks[0].marks.length, 2, "两件事都还在这道线上");
});

test("比所有消息都新的压缩，线画在最后面", () => {
  const timeline = buildConversationTimeline([...messages], [], [], undefined, {
    summaryEvents: [],
    contextClearings: [{ at: 9_999, clearedResults: 2, freedTokens: 0 }],
  });
  assert.equal(timeline.at(-1)?.kind, "compaction");
});

test("没有压缩过的对话，时间线跟原来一模一样", () => {
  const withMarks = buildConversationTimeline([...messages], [], [], undefined, { summaryEvents: [] });
  const without = buildConversationTimeline([...messages], []);
  assert.deepEqual(withMarks.map((item) => [item.kind, item.order]), without.map((item) => [item.kind, item.order]));
});
