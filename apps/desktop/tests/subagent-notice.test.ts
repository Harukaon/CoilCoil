import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "@coilcoil/runtime-protocol";
import {
  parseSubagentCompletion,
  subagentCompletionLabel,
  subagentCompletionMeta,
} from "../src/renderer/src/features/conversation/subagentNotice.ts";

const message = (details: Record<string, unknown>, type = "subagent-complete"): ChatMessage => ({
  id: "m1",
  order: 1,
  role: "system",
  text: "子 Agent 已完成（runId=sa-1）会话文件：/tmp/x.jsonl 最终输出：……",
  timestamp: 0,
  custom: { type, details },
} as ChatMessage);

test("完成通知读 details，不读给模型看的正文", () => {
  const notice = parseSubagentCompletion(message({
    runId: "sa-1", agent: "explore", status: "completed", task: "看一下 README",
    finalOutput: "## 报告\n没问题", toolCount: 2, durationMs: 65_000, sessionFile: "/tmp/x.jsonl",
  }));
  assert.deepEqual(notice, {
    agent: "explore", status: "completed", task: "看一下 README", report: "## 报告\n没问题",
    error: undefined, toolCount: 2, durationMs: 65_000,
  });
  assert.equal(subagentCompletionMeta(notice!), "2 次工具 · 1 分 5 秒");
});

test("失败和停止各有自己的说法，错误信息带出来", () => {
  const failed = parseSubagentCompletion(message({ agent: "worker", status: "failed", error: "模型超时" }));
  assert.equal(subagentCompletionLabel(failed!.status), "失败");
  assert.equal(failed?.error, "模型超时");
  assert.equal(subagentCompletionLabel("stopped"), "已停止");
});

test("别的系统消息不当成子 Agent 通知", () => {
  assert.equal(parseSubagentCompletion(message({}, "terminal-notification")), undefined);
});
