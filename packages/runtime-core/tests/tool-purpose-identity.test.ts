import assert from "node:assert/strict";
import test from "node:test";
import { restoredPurposeFor, restoredToolPurposes } from "../src/session-values.js";
import { WORKFLOW_AUDIT_ENTRY_TYPE } from "../src/runtime-constants.js";
import { ToolRunIds } from "../src/tool-run-ids.js";

/**
 * The audit trail says which purpose belongs to which call. This checks that it
 * still says so once a provider starts reusing its tool call ids.
 */
function sessionWith(entries: Array<{ toolCallId: string; toolName: string; purpose: string }>): never {
  return {
    sessionManager: {
      getEntries: () => entries.map((data, index) => ({
        id: `e${index}`,
        type: "custom",
        customType: WORKFLOW_AUDIT_ENTRY_TYPE,
        data: { ...data, timestamp: 1_000 + index },
      })),
    },
  } as never;
}

test("同一个 tool call id 出现两次，两条解释要各归各的", () => {
  // openai-completions 那类提供方（DeepSeek 等）每轮从 call_0 重新编号，
  // tool-run-ids.ts 的注释里写得很清楚。所以一个会话里 call_0 会出现很多次，
  // 每次是完全不同的一次调用，各自有各自的目的。
  const purposes = restoredToolPurposes(sessionWith([
    { toolCallId: "call_0", toolName: "read", purpose: "看一眼配置文件" },
    { toolCallId: "call_0", toolName: "edit", purpose: "把端口改成 8443" },
    { toolCallId: "call_0", toolName: "bash", purpose: "跑一遍测试" },
  ]));

  const ids = new ToolRunIds();
  const first = ids.begin("call_0"); ids.end("call_0");
  const second = ids.begin("call_0"); ids.end("call_0");
  const third = ids.begin("call_0"); ids.end("call_0");

  assert.equal(restoredPurposeFor(purposes, first, "read"), "看一眼配置文件");
  assert.equal(restoredPurposeFor(purposes, second, "edit"), "把端口改成 8443", "第二次调用不能顶着第一次的解释");
  assert.equal(restoredPurposeFor(purposes, third, "bash"), "跑一遍测试");
});

test("解释按会话里的先后配对，不是按最后一条覆盖前面所有", () => {
  const purposes = restoredToolPurposes(sessionWith([
    { toolCallId: "call_1", toolName: "read", purpose: "A" },
    { toolCallId: "call_0", toolName: "read", purpose: "B" },
    { toolCallId: "call_1", toolName: "grep", purpose: "C" },
  ]));
  assert.equal(restoredPurposeFor(purposes, "call_1", "read"), "A");
  assert.equal(restoredPurposeFor(purposes, "call_0", "read"), "B");
  assert.equal(restoredPurposeFor(purposes, "call_1#2", "grep"), "C");
});

test("id 本来就唯一的提供方，一个后缀都不该出现", () => {
  // anthropic-messages 和 openai-responses 每次调用都是全局唯一 id，
  // 这条保证修复不会给它们凭空造出对不上的 key。
  const purposes = restoredToolPurposes(sessionWith([
    { toolCallId: "toolu_01A", toolName: "read", purpose: "读 A" },
    { toolCallId: "toolu_01B", toolName: "edit", purpose: "改 B" },
  ]));
  assert.deepEqual([...purposes.keys()].sort(), ["toolu_01A", "toolu_01B"]);
});

test("没有目的或没有 id 的审计条目直接跳过，不占号", () => {
  const purposes = restoredToolPurposes(sessionWith([
    { toolCallId: "call_0", toolName: "read", purpose: "   " },
    { toolCallId: "", toolName: "read", purpose: "没有 id" },
    { toolCallId: "call_0", toolName: "edit", purpose: "真正的第一条" },
  ]));
  assert.equal(restoredPurposeFor(purposes, "call_0", "edit"), "真正的第一条");
  assert.equal(purposes.size, 1);
});

test("工具名对不上就不显示解释——宁可没有，也不能安错人", () => {
  // 模型announce了却没执行的调用会占掉一个号但不写审计条目，两边的编号就会
  // 错开一位。工具名是这里唯一的校验：给 bash 写的解释绝不能盖在 edit 上。
  const purposes = restoredToolPurposes(sessionWith([
    { toolCallId: "call_0", toolName: "bash", purpose: "跑一遍测试" },
  ]));
  assert.equal(restoredPurposeFor(purposes, "call_0", "bash"), "跑一遍测试");
  assert.equal(restoredPurposeFor(purposes, "call_0", "edit"), undefined);
  assert.equal(restoredPurposeFor(purposes, "call_0#2", "bash"), undefined, "错开一位时不许兜底到前一条");
});
