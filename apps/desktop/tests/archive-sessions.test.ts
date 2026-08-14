import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectSelection, SessionSummary } from "@suocode/runtime-protocol";
import { filterArchivedSessionGroups } from "../src/renderer/src/features/workspaces/archiveSessions.ts";

const projects: ProjectSelection[] = [
  { name: "Home", path: "/home", kind: "home" },
  { name: "Project", path: "/project", kind: "workspace" },
];

const session = (path: string, title: string): SessionSummary => ({
  id: path,
  path,
  cwd: path.startsWith("/home") ? "/home" : "/project",
  title,
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
  messageCount: 1,
});

test("archived sessions are grouped by workspace and searched by title", () => {
  const archives = {
    "/home": [session("/home/first.jsonl", "实现浏览器调试"), session("/home/second.jsonl", "修复模型菜单")],
    "/project": [session("/project/third.jsonl", "浏览器回归")],
  };
  assert.deepEqual(filterArchivedSessionGroups(projects, archives, "浏览器").map((group) => ({
    project: group.project.name,
    titles: group.sessions.map((item) => item.title),
  })), [
    { project: "Home", titles: ["实现浏览器调试"] },
    { project: "Project", titles: ["浏览器回归"] },
  ]);
  assert.deepEqual(filterArchivedSessionGroups(projects, archives, " 模型 ")[0]?.sessions.map((item) => item.title), ["修复模型菜单"]);
  assert.deepEqual(filterArchivedSessionGroups(projects, archives, "不存在"), []);
});
