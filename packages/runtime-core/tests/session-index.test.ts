import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessionsForCwd, readSessionDetail, sessionBelongsTo } from "../src/session-index.js";

const PROJECT = "/tmp/coilcoil-project";
const OTHER = "/tmp/coilcoil-other";

function line(entry: unknown): string {
  return `${JSON.stringify(entry)}\n`;
}

function header(cwd: string, at = "2026-09-01T00:00:00.000Z", id = "s1"): string {
  return line({ type: "session", id, cwd, timestamp: at });
}

function message(role: string, text: string, at?: number): string {
  return line({
    type: "message",
    timestamp: "2026-09-01T00:01:00.000Z",
    message: { role, content: [{ type: "text", text }], ...(at ? { timestamp: at } : {}) },
  });
}

function sessionDir(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "coilcoil-index-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(directory, name), content, "utf8");
  }
  return directory;
}

test("只认属于这个工作区的会话，靠的是第一行", async () => {
  // 这就是整件事的关键：属于哪个工作区写在文件头里，为了知道这一点而把
  // 几百个文件整个读一遍，是纯粹的浪费。
  const directory = sessionDir({
    "mine.jsonl": header(PROJECT) + message("user", "我的"),
    "theirs.jsonl": header(OTHER) + message("user", "别人的"),
  });
  const sessions = await listSessionsForCwd(directory, PROJECT);
  assert.deepEqual(sessions.map((entry) => entry.firstMessage), ["我的"]);
});

test("工作区匹配和 pi 一样按解析后的绝对路径比", () => {
  assert.equal(sessionBelongsTo("/tmp/a", "/tmp/a"), true);
  assert.equal(sessionBelongsTo("/tmp/a/../a", "/tmp/a"), true);
  assert.equal(sessionBelongsTo("/tmp/b", "/tmp/a"), false);
  assert.equal(sessionBelongsTo("", "/tmp/a"), false);
  assert.equal(sessionBelongsTo(undefined, "/tmp/a"), false);
});

test("不是会话的文件、坏文件、非 jsonl，都安静跳过", async () => {
  const directory = sessionDir({
    "good.jsonl": header(PROJECT) + message("user", "正常"),
    "notasession.jsonl": line({ type: "message", message: { role: "user", content: [] } }),
    "broken.jsonl": "{这不是 JSON\n",
    "empty.jsonl": "",
    "notes.md": header(PROJECT),
  });
  const sessions = await listSessionsForCwd(directory, PROJECT);
  assert.deepEqual(sessions.map((entry) => entry.firstMessage), ["正常"]);
});

test("标题取最后一次改的名字，没改过才用第一条用户消息", async () => {
  const named = sessionDir({
    "a.jsonl": header(PROJECT)
      + line({ type: "session_info", name: "旧名字" })
      + message("user", "第一句")
      + line({ type: "session_info", name: "新名字" }),
  });
  assert.equal((await listSessionsForCwd(named, PROJECT))[0]?.name, "新名字");

  const unnamed = sessionDir({ "a.jsonl": header(PROJECT) + message("assistant", "我先说的") + message("user", "用户第一句") });
  const entry = (await listSessionsForCwd(unnamed, PROJECT))[0];
  assert.equal(entry?.name, undefined);
  // 标题要的是用户说的第一句，不是助手先开口的那句。
  assert.equal(entry?.firstMessage, "用户第一句");
});

test("一条消息都没有也说得清楚", async () => {
  const directory = sessionDir({ "a.jsonl": header(PROJECT) });
  const entry = (await listSessionsForCwd(directory, PROJECT))[0];
  assert.equal(entry?.messageCount, 0);
  assert.equal(entry?.firstMessage, "(no messages)");
});

test("消息条数算的是全部消息，不只是对话", async () => {
  const directory = sessionDir({
    "a.jsonl": header(PROJECT)
      + message("user", "问")
      + message("assistant", "答")
      + line({ type: "message", timestamp: "2026-09-01T00:02:00.000Z", message: { role: "toolResult", content: [] } }),
  });
  assert.equal((await listSessionsForCwd(directory, PROJECT))[0]?.messageCount, 3);
});

test("最后活动时间只认人和模型说的话，且消息自带的时间优先", async () => {
  // 这条错了不会报错，只会让会话列表悄悄排错序、显示错的「最近使用」。
  const directory = sessionDir({
    "a.jsonl": header(PROJECT)
      + message("user", "问", 1_700_000_000_000)
      + line({ type: "message", timestamp: "2099-01-01T00:00:00.000Z", message: { role: "toolResult", content: [] } }),
  });
  const entry = (await listSessionsForCwd(directory, PROJECT))[0];
  assert.equal(entry?.modified.getTime(), 1_700_000_000_000, "工具消息不该把时间往前推");
});

test("列表按最近活动倒序", async () => {
  const directory = sessionDir({
    "old.jsonl": header(PROJECT, "2026-09-01T00:00:00.000Z", "old") + message("user", "早的", 1_000),
    "new.jsonl": header(PROJECT, "2026-09-01T00:00:00.000Z", "new") + message("user", "晚的", 9_000),
  });
  assert.deepEqual(
    (await listSessionsForCwd(directory, PROJECT)).map((entry) => entry.firstMessage),
    ["晚的", "早的"],
  );
});

test("目录不存在就是空列表，不是错误", async () => {
  assert.deepEqual(await listSessionsForCwd("/definitely/not/here", PROJECT), []);
});

test("单个文件读不出来时返回空，不影响别人", async () => {
  assert.equal(await readSessionDetail("/definitely/not/here.jsonl"), undefined);
});
