import type { Issue, IssueNote, IssuePriority, IssueStatus } from "../../../../shared/desktop-api";

/**
 * 工作区看板的纯逻辑：排序、下一条该做哪个、状态怎么流转、发给 agent 的那段话。
 *
 * 全部是纯函数，不碰 React 也不碰 window——面板和执行器都从这里取，测试直接调。
 */

export const ISSUE_COLUMNS: { status: IssueStatus; name: string }[] = [
  { status: "todo", name: "待办" },
  { status: "doing", name: "进行中" },
  { status: "review", name: "待验收" },
  { status: "reply", name: "待回复" },
  { status: "done", name: "完成" },
];

export const ISSUE_STATUS_NAME: Record<IssueStatus, string> =
  Object.fromEntries(ISSUE_COLUMNS.map((column) => [column.status, column.name])) as Record<IssueStatus, string>;

export const ISSUE_PRIORITY_NAME: Record<IssuePriority, string> = { high: "高", medium: "中", low: "低" };

/** 高的排前面。用户明确要了优先级，那它就得决定「挨个做」的顺序。 */
const PRIORITY_RANK: Record<IssuePriority, number> = { high: 0, medium: 1, low: 2 };

export function newIssue(title: string, body: string, priority: IssuePriority): Issue {
  const now = new Date().toISOString();
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: title.trim(),
    body: body.trim(),
    status: "todo",
    priority,
    createdAt: now,
    updatedAt: now,
    notes: [],
  };
}

/** 先按优先级，同级按提出的先后——先提的先做，不然低优先级的永远排不上。 */
export function sortIssues(issues: readonly Issue[]): Issue[] {
  return [...issues].sort((a, b) =>
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt.localeCompare(b.createdAt));
}

export function issuesInColumn(issues: readonly Issue[], status: IssueStatus): Issue[] {
  return sortIssues(issues.filter((issue) => issue.status === status));
}

/**
 * 「开始」按下去之后该做哪一条。
 *
 * 只从待办里挑，而且已经有一条在进行中时一条都不挑：第一版是串行的，同时跑两条
 * 就要有人去判断它们会不会改到同一个文件，那是管控的活，不该让它自己来。
 */
export function nextRunnableIssue(issues: readonly Issue[]): Issue | undefined {
  if (issues.some((issue) => issue.status === "doing")) return undefined;
  return sortIssues(issues.filter((issue) => issue.status === "todo"))[0];
}

/** 发给 agent 的那段话。要它自己说清楚做了什么，因为验收的是人。 */
export function issuePrompt(issue: Issue): string {
  const lines = [
    `【看板】${issue.title}`,
    "",
    issue.body || "（这条没有写描述，按标题理解。）",
    "",
    "这是这个工作区看板上的一条 Issue，请你把它做完。",
    "做完之后用一两句话说明你改了什么、怎么验证的；做不了或者需要我先拿个主意，就直接说卡在哪，不要硬做。",
  ];
  return lines.join("\n");
}

function touch(issue: Issue, patch: Partial<Issue>): Issue {
  return { ...issue, ...patch, updatedAt: new Date().toISOString() };
}

export function upsertIssue(issues: readonly Issue[], issue: Issue): Issue[] {
  const known = issues.some((item) => item.id === issue.id);
  return known ? issues.map((item) => item.id === issue.id ? issue : item) : [...issues, issue];
}

export function withStatus(issues: readonly Issue[], id: string, status: IssueStatus): Issue[] {
  return issues.map((issue) => issue.id === id ? touch(issue, { status }) : issue);
}

export function withNote(issues: readonly Issue[], id: string, note: IssueNote): Issue[] {
  return issues.map((issue) => issue.id === id ? touch(issue, { notes: [...issue.notes, note] }) : issue);
}

export function removeIssue(issues: readonly Issue[], id: string): Issue[] {
  return issues.filter((issue) => issue.id !== id);
}

export function agentNote(text: string): IssueNote {
  return { at: new Date().toISOString(), by: "agent", text };
}

export function userNote(text: string): IssueNote {
  return { at: new Date().toISOString(), by: "user", text };
}
