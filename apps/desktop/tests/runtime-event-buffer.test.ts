import assert from "node:assert/strict";
import test from "node:test";
import { coalesceRuntimeEvents, type BufferedRuntimeEvent } from "../src/renderer/src/hooks/useBufferedRuntimeEvents.ts";

function delta(id: string, text: string, revision: number, runtimeId = "runtime-a"): BufferedRuntimeEvent {
  return { runtimeId, event: { type: "message_delta", id, field: "text", delta: text, revision } };
}

test("同一条消息的连续文本增量合并成一次更新并保留最新 revision", () => {
  const folded = coalesceRuntimeEvents([delta("m1", "你", 1), delta("m1", "好", 2), delta("m1", "吗", 3)]);
  assert.equal(folded.length, 1);
  assert.deepEqual(folded[0].event, { type: "message_delta", id: "m1", field: "text", delta: "你好吗", revision: 3 });
});

test("思考与正文分属不同字段，不会被合并到一起", () => {
  const folded = coalesceRuntimeEvents([
    { runtimeId: "runtime-a", event: { type: "message_delta", id: "m1", field: "thinking", delta: "推理", revision: 1 } },
    delta("m1", "回答", 2),
  ]);
  assert.equal(folded.length, 2);
  assert.equal(folded[0].event.type === "message_delta" && folded[0].event.field, "thinking");
});

test("夹在中间的事件保持原有顺序，增量不会跨过它合并", () => {
  const toolStarted: BufferedRuntimeEvent = {
    runtimeId: "runtime-a",
    event: {
      type: "tool_started",
      tool: { id: "t1", order: 1, name: "read", label: "read", args: {}, output: "", status: "running", startedAt: 0 },
    },
  };
  const folded = coalesceRuntimeEvents([delta("m1", "前", 1), toolStarted, delta("m1", "后", 2)]);
  assert.deepEqual(folded.map((entry) => entry.event.type), ["message_delta", "tool_started", "message_delta"]);
});

test("不同会话运行时的增量各自成批", () => {
  const folded = coalesceRuntimeEvents([delta("m1", "甲", 1, "runtime-a"), delta("m1", "乙", 1, "runtime-b")]);
  assert.equal(folded.length, 2);
});

test("没有事件时返回空批次", () => {
  assert.deepEqual(coalesceRuntimeEvents([]), []);
});
