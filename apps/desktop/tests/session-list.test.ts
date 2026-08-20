import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectSelection, SessionSummary } from "@coilcoil/runtime-protocol";
import {
  collectPinnedSessions,
  collapsedSessionLimit,
  nextExpandedSessionLimit,
  summarizeWorkspaceActivity,
  titleFromPrompt,
  upsertSessionSummary,
  workspaceActivityLabel,
} from "../src/renderer/src/features/workspaces/sessionList.ts";

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

test("置顶会话在全局区排序，但保留原工作区归属", () => {
  const projects = [
    { kind: "workspace", name: "A", path: "/a" },
    { kind: "workspace", name: "B", path: "/b" },
  ] as ProjectSelection[];
  const sessionsByProject = {
    "/a": [{ ...session({ id: "a-1", title: "A 会话" }), pinned: true, pinnedAt: "2026-08-15T00:00:00.000Z" }],
    "/b": [{ ...session({ id: "b-1", title: "B 会话" }), pinned: true, pinnedAt: "2026-08-16T00:00:00.000Z" }],
  };
  const pinned = collectPinnedSessions(projects, sessionsByProject);
  assert.deepEqual(pinned.map((entry) => [entry.session.id, entry.project.path]), [["b-1", "/b"], ["a-1", "/a"]]);
});

test("工作区默认展示四行会话", () => {
  assert.equal(collapsedSessionLimit(false), 4);
  assert.equal(collapsedSessionLimit(true), 3);
});

test("更多会话每次只追加四行并且不会超过总数", () => {
  assert.equal(nextExpandedSessionLimit(4, 20), 8);
  assert.equal(nextExpandedSessionLimit(8, 20), 12);
  assert.equal(nextExpandedSessionLimit(12, 14), 14);
});

test("a workspace reports the running conversations hidden inside it", () => {
  const sessions = [
    session({ id: "a", path: "/sessions/a.jsonl" }),
    session({ id: "b", path: "/sessions/b.jsonl" }),
    session({ id: "c", path: "/sessions/c.jsonl" }),
  ];
  const summary = summarizeWorkspaceActivity(sessions, {
    "/sessions/a.jsonl": { running: true, unread: false },
    "/sessions/b.jsonl": { running: false, unread: true },
    "/sessions/c.jsonl": { running: false, unread: false },
  });
  assert.deepEqual(summary, { running: 1, unread: 1 });
  assert.equal(workspaceActivityLabel(summary), "1 个对话运行中");
});

test("a finished conversation only counts as unread once it stops running", () => {
  const sessions = [session({ id: "a", path: "/sessions/a.jsonl" })];
  const running = summarizeWorkspaceActivity(sessions, { "/sessions/a.jsonl": { running: true, unread: true } });
  assert.deepEqual(running, { running: 1, unread: 0 });
  const done = summarizeWorkspaceActivity(sessions, { "/sessions/a.jsonl": { running: false, unread: true } });
  assert.equal(workspaceActivityLabel(done), "1 个对话有新回复");
});

test("a quiet workspace shows nothing", () => {
  assert.equal(workspaceActivityLabel(summarizeWorkspaceActivity([], {})), undefined);
  assert.equal(workspaceActivityLabel(summarizeWorkspaceActivity(undefined, {})), undefined);
});
