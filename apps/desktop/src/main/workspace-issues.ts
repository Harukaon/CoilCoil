import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Issue, IssueNote, IssuePriority, IssueStatus } from "../shared/desktop-api";

/**
 * 每个工作区自己的 Issue 看板，存在 CoilCoil 的 userData 下。
 *
 * 不写进用户的仓库：那样会被顺手 commit 上去，还会跟着推到别的机器；这是「我让
 * 它改什么」的私人清单，不是项目的一部分。文件按工作区路径分开，一个工作区一份。
 *
 * 这里的函数不 import electron，目录由调用方给，方便单测。
 */

const STATUSES: IssueStatus[] = ["todo", "doing", "review", "reply", "done"];
const PRIORITIES: IssuePriority[] = ["high", "medium", "low"];

/** 一块看板再大也不该无限大；坏数据灌进来时这也是一道闸。 */
const MAX_ISSUES = 2000;
/** 一条 Issue 的留言同理。 */
const MAX_NOTES = 500;

/**
 * 工作区路径 → 文件名。
 *
 * 路径里有斜杠、空格、中文，直接当文件名不行；用哈希，再把最后一段目录名接在
 * 前面，这样在 Finder 里翻到这个目录时还认得出哪份是哪个项目的。
 */
export function issuesFileFor(directory: string, cwd: string): string {
  const leaf = (cwd.split("/").filter(Boolean).pop() ?? "workspace").replace(/[^\w.-]/g, "_").slice(0, 40);
  const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  return join(directory, "issues", `${leaf}-${digest}.json`);
}

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function normalizeNote(value: unknown): IssueNote | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const body = text(record.text, 20_000);
  if (!body) return undefined;
  return {
    at: text(record.at, 40) || new Date().toISOString(),
    by: record.by === "agent" ? "agent" : "user",
    text: body,
  };
}

function normalizeIssue(value: unknown): Issue | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const id = text(record.id, 64);
  const title = text(record.title, 300).trim();
  if (!id || !title) return undefined;
  const now = new Date().toISOString();
  const sessionPath = text(record.sessionPath, 4_096);
  return {
    id,
    title,
    body: text(record.body, 100_000),
    status: STATUSES.includes(record.status as IssueStatus) ? record.status as IssueStatus : "todo",
    priority: PRIORITIES.includes(record.priority as IssuePriority) ? record.priority as IssuePriority : "medium",
    createdAt: text(record.createdAt, 40) || now,
    updatedAt: text(record.updatedAt, 40) || now,
    notes: Array.isArray(record.notes)
      ? record.notes.map(normalizeNote).filter((note): note is IssueNote => Boolean(note)).slice(0, MAX_NOTES)
      : [],
    // 没跑过的 Issue 不要留一个空的键，写出来的 JSON 也干净些。
    ...sessionPath ? { sessionPath } : {},
  };
}

/** 只保留认得出来的条目，按 id 去重，顺序保持不变。 */
export function normalizeIssues(value: unknown): Issue[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const entry of value) {
    const issue = normalizeIssue(entry);
    if (!issue || seen.has(issue.id)) continue;
    seen.add(issue.id);
    out.push(issue);
    if (out.length >= MAX_ISSUES) break;
  }
  return out;
}

/** 读不到、读坏了都当作空看板——打开面板不能因为这个文件失败。 */
export function readIssues(file: string): Issue[] {
  try {
    return normalizeIssues(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return [];
  }
}

/**
 * 写盘，返回真正落盘的那一份。
 *
 * 和挂载清单一样不抛：写不进去的代价是这次的改动没保存，而让「提一条 Issue」
 * 这个动作本身报错的代价更大。
 */
export function writeIssues(file: string, value: unknown): Issue[] {
  const issues = normalizeIssues(value);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(issues, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error("[issues] 看板写盘失败", error);
  }
  return issues;
}
