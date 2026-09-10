import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, RuntimeSummaryEvent } from "@coilcoil/runtime-protocol";
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
  assert.equal(compactionMarkLabel(marks[0]), "已清理 7 条工具输出");
  assert.match(compactionMarkDetail(marks[0]), /7 条工具输出/);
  assert.match(compactionMarkDetail(marks[0]), /9,100/);
  assert.match(compactionMarkDetail(marks[0]), /调用参数还留着/);
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
