import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectSelection, SessionSummary } from "@coilcoil/runtime-protocol";
import {
  collectPinnedSessions,
  collapsedSessionLimit,
  conversationStatusKind,
  nextExpandedSessionLimit,
  summarizeWorkspaceActivity,
  titleFromPrompt,
  upsertSessionSummary,
  visibleProjectSessions,
  workspaceActivityLabel,
} from "../src/renderer/src/features/workspaces/sessionList.ts";

const project = (name: string): ProjectSelection => ({ kind: "workspace", name, path: `/projects/${name}` });

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

test("a running conversation says so even when it is pinned", () => {
  // The pinned rows are the ones watched from another project, so losing the
  // spinner to the pin is exactly where a long job goes unnoticed.
  assert.equal(conversationStatusKind({ running: true, unread: false }, true), "running");
  assert.equal(conversationStatusKind({ running: true, unread: true }, true), "running");
});

test("a pinned conversation that finished unwatched shows the unread mark", () => {
  assert.equal(conversationStatusKind({ running: false, unread: true }, true), "unread");
});

test("the pin only speaks when the conversation is quiet", () => {
  assert.equal(conversationStatusKind({ running: false, unread: false }, true), "pinned");
  assert.equal(conversationStatusKind(undefined, true), "pinned");
  assert.equal(conversationStatusKind(undefined, false), "none");
});

test("置顶是把对话挪走，不是复制一份：文件夹里不再有它", () => {
  // 两种做法都试过。曾经为了不让它「消失」而在文件夹里也留一行，用下来重复的那
  // 一行才是别扭的：「置顶了，就可以从他们的文件夹里面移除了…体验下来不符合逻
  // 辑」。顶上那条置顶区会写明它属于哪个工作区，所以它不是没了，是搬走了。
  const pinned = session({ id: "pinned", path: "/sessions/pinned.jsonl", pinned: true });
  const plain = ["a", "b", "c", "d"].map((id) => session({ id, path: `/sessions/${id}.jsonl` }));
  const view = visibleProjectSessions([pinned, ...plain], 4);
  assert.deepEqual(view.rows.map((item) => item.id), ["a", "b", "c", "d"]);
  assert.equal(view.hiddenCount, 0);
  assert.equal(view.plainTotal, 4, "置顶的不算这个文件夹的条数");
});

test("四行的额度只算没置顶的对话", () => {
  const pinned = session({ id: "pinned", path: "/sessions/pinned.jsonl", pinned: true });
  const plain = ["a", "b", "c", "d", "e", "f"].map((id) => session({ id, path: `/sessions/${id}.jsonl` }));
  const view = visibleProjectSessions([pinned, ...plain], 4);
  assert.deepEqual(view.rows.map((item) => item.id), ["a", "b", "c", "d"]);
  assert.equal(view.hiddenCount, 2);
  assert.equal(view.plainTotal, 6);
});

test("文件夹上的角标不再替已经搬走的对话说话", () => {
  // 置顶的那条在跑，但它已经不在这个文件夹底下了。文件夹要是还写「1 个对话运行
  // 中」，展开却一行都不在跑，那就是当初那个 bug 换了个方向又回来了。
  const running = session({ id: "pinned", path: "/sessions/pinned.jsonl", pinned: true });
  const all = [running, ...["a", "b", "c", "d"].map((id) => session({ id, path: `/sessions/${id}.jsonl` }))];
  const activity = { "/sessions/pinned.jsonl": { running: true, unread: false } };
  assert.equal(summarizeWorkspaceActivity(all, activity).running, 0);
  assert.equal(visibleProjectSessions(all, 4).rows.some((item) => item.pinned), false);
});

test("没有置顶的时候，行为和原来完全一样", () => {
  const plain = ["a", "b", "c", "d", "e"].map((id) => session({ id, path: `/sessions/${id}.jsonl` }));
  const view = visibleProjectSessions(plain, 4);
  assert.deepEqual(view.rows.map((item) => item.id), ["a", "b", "c", "d"]);
  assert.equal(view.hiddenCount, 1);
  assert.equal(view.plainTotal, 5);
});
