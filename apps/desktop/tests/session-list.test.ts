import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "@suocode/runtime-protocol";
import { titleFromPrompt, upsertSessionSummary } from "../src/renderer/src/features/workspaces/sessionList.ts";

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: "session-1",
    path: "/sessions/session-1.jsonl",
    cwd: "/workspace",
    title: "旧对话",
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
    messageCount: 2,
    ...overrides,
  };
}

test("首条消息可以立即生成左侧会话标题", () => {
  assert.equal(titleFromPrompt("  帮我检查一下\n这个项目  ", false), "帮我检查一下 这个项目");
  assert.equal(titleFromPrompt("", true), "图片对话");
});

test("新创建的会话立即插入列表且不会重复", () => {
  const existing = session({ id: "old", path: "/sessions/old.jsonl" });
  const created = session({
    id: "new",
    path: "/sessions/new.jsonl",
    title: "刚发送的消息",
    updatedAt: "2026-08-09T11:00:00.000Z",
    messageCount: 1,
  });

  const inserted = upsertSessionSummary([existing], created);
  assert.deepEqual(inserted.map((item) => item.id), ["new", "old"]);

  const authoritative = { ...created, title: "运行时正式标题", messageCount: 3 };
  const updated = upsertSessionSummary(inserted, authoritative);
  assert.equal(updated.filter((item) => item.id === "new").length, 1);
  assert.equal(updated[0]?.title, "运行时正式标题");
});

test("置顶会话仍保持在普通新会话之前", () => {
  const pinned = session({ id: "pinned", path: "/sessions/pinned.jsonl", pinned: true });
  const created = session({
    id: "new",
    path: "/sessions/new.jsonl",
    title: "刚发送的消息",
    updatedAt: "2026-08-09T11:00:00.000Z",
  });

  assert.deepEqual(upsertSessionSummary([pinned], created).map((item) => item.id), ["pinned", "new"]);
});
