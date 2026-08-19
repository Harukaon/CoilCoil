import assert from "node:assert/strict";
import test from "node:test";
import { WORKFLOW_PURPOSE_REGISTRY } from "../src/runtime-constants.js";
import { liveToolPurpose } from "../src/session-values.js";

const SEPARATOR = "\0";

function seed(entries: Array<[string, string, string]>): void {
  const registry = new Map<string, { purpose: string }>();
  for (const [sessionId, toolCallId, purpose] of entries) {
    registry.set(`${sessionId}${SEPARATOR}${toolCallId}`, { purpose });
  }
  (globalThis as Record<PropertyKey, unknown>)[WORKFLOW_PURPOSE_REGISTRY] = registry;
}

function clear(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[WORKFLOW_PURPOSE_REGISTRY];
}

test("two sessions that reuse a tool call id keep their own purposes", (t) => {
  t.after(clear);
  // Several providers number tool calls per response, so `call_0` is handed out
  // again by every conversation. The registry lives on globalThis and is shared
  // by every session open in the process, so keying it on the bare id painted
  // one conversation's purpose onto another conversation's tool card.
  seed([
    ["session-a", "call_0", "查看现有 SSH 配置文件内容"],
    ["session-b", "call_0", "复查两个用户全部订阅的可用状态"],
  ]);

  assert.equal(liveToolPurpose("session-a", "call_0"), "查看现有 SSH 配置文件内容");
  assert.equal(liveToolPurpose("session-b", "call_0"), "复查两个用户全部订阅的可用状态");
});

test("an unknown session never borrows another session's purpose", (t) => {
  t.after(clear);
  seed([["session-a", "call_0", "查看现有 SSH 配置文件内容"]]);

  assert.equal(liveToolPurpose("session-c", "call_0"), undefined);
  assert.equal(liveToolPurpose(undefined, "call_0"), undefined);
  assert.equal(liveToolPurpose("session-a", undefined), undefined);
});
