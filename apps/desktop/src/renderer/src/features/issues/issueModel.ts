import type { Issue, IssueEvent, IssuePriority, IssueStatus } from "../../../../shared/desktop-api";

/**
 * 任务面板的纯逻辑：状态怎么流转、「开始」该挑哪一条、批阅队列里排谁、时间线怎么合。
 *
 * 全部是纯函数，不碰 React 也不碰 window——面板、批阅界面和执行器都从这里取。
 */

export const ISSUE_COLUMNS: { status: IssueStatus; name: string; hint: string }[] = [
  { status: "pool", name: "待办池", hint: "先记下来的想法，不排队，也不会被拿去做" },
  { status: "ready", name: "待处理", hint: "CoilCoil 的队列，「开始」只从这里挑" },
  { status: "doing", name: "进行中", hint: "正在做的那一条" },
  { status: "review", name: "待验收", hint: "做完了等你看" },
  { status: "reply", name: "待回复", hint: "它卡住了，等你拿个主意" },
  { status: "done", name: "完成", hint: "验收通过的" },
];

export const ISSUE_STATUS_NAME: Record<IssueStatus, string> =
  Object.fromEntries(ISSUE_COLUMNS.map((column) => [column.status, column.name])) as Record<IssueStatus, string>;

export const ISSUE_PRIORITY_NAME: Record<IssuePriority, string> = { high: "高", medium: "中", low: "低" };

/** 高的排前面。用户明确要了优先级，那它就得决定「挨个做」的顺序。 */
const PRIORITY_RANK: Record<IssuePriority, number> = { high: 0, medium: 1, low: 2 };

export function newIssue(
  title: string,
  body: string,
  priority: IssuePriority,
  options: { status?: IssueStatus; parentId?: string } = {},
): Issue {
  const now = new Date().toISOString();
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: title.trim(),
    body: body.trim(),
    status: options.status ?? "pool",
    priority,
    createdAt: now,
    updatedAt: now,
    events: [],
    ...options.parentId ? { parentId: options.parentId } : {},
  };
}

export function comment(text: string, by: IssueEvent["by"] = "user"): IssueEvent {
  return { at: new Date().toISOString(), by, kind: "comment", text };
}

export function agentNote(text: string): IssueEvent {
  return { at: new Date().toISOString(), by: "agent", kind: "note", text };
}

function statusEvent(status: IssueStatus, by: IssueEvent["by"], text: string): IssueEvent {
  return { at: new Date().toISOString(), by, kind: "status", status, text };
}

/** 先按优先级，同级按提出的先后——先提的先做，不然低优先级的永远排不上。 */
export function sortIssues(issues: readonly Issue[]): Issue[] {
  return [...issues].sort((a, b) =>
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt.localeCompare(b.createdAt));
}

export function issuesInColumn(issues: readonly Issue[], status: IssueStatus): Issue[] {
  return sortIssues(issues.filter((issue) => issue.status === status));
}

export function childrenOf(issues: readonly Issue[], parentId: string): Issue[] {
  return sortIssues(issues.filter((issue) => issue.parentId === parentId));
}

/**
 * 「开始」按下去之后该做哪一条。
 *
 * 只从待处理里挑：待办池是给想法用的，没说要做的东西不该被拿去做。已经有一条在
 * 进行中时一条都不挑——同时跑两条就要有人判断它们会不会改到同一个文件。
 */
export function nextRunnableIssue(issues: readonly Issue[]): Issue | undefined {
  if (issues.some((issue) => issue.status === "doing")) return undefined;
  return sortIssues(issues.filter((issue) => issue.status === "ready"))[0];
}

/**
 * 批阅队列：等着你处理的那些，一次看一条。
 *
 * 待回复排在待验收前面——它是卡着 AI 的，你不回它就一直停在那儿；待验收只是等你
 * 过目。标了「以后再验收」的不进队列，但仍然留在待验收那一列里。
 */
export function reviewQueue(issues: readonly Issue[]): Issue[] {
  const waiting = issues.filter((issue) =>
    issue.status === "reply" || (issue.status === "review" && !issue.deferred));
  return waiting.sort((a, b) =>
    Number(a.status === "review") - Number(b.status === "review")
    || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || a.updatedAt.localeCompare(b.updatedAt));
}

/** 发给 agent 的那段话。要它自己说清楚做了什么，因为验收的是人。 */
export function issuePrompt(issue: Issue, parent?: Issue): string {
  return [
    `【任务面板】${issue.title}`,
    parent ? `（这是「${parent.title}」下面的一条子任务）` : "",
    "",
    issue.body || "（这条没有写描述，按标题理解。）",
    ...issue.events.filter((event) => event.kind === "comment" || event.kind === "note").slice(-6).map(
      (event) => `\n${event.by === "user" ? "我" : "你上一轮"}说：${event.text}`),
    "",
    "这是这个工作区任务面板上的一条，请你把它做完。",
    "做完之后用一两句话说明你改了什么、怎么验证的；需要我先拿个主意才能往下走，就直接说卡在哪，不要硬做。",
  ].filter((line) => line !== "").join("\n");
}

function patch(issue: Issue, changes: Partial<Issue>, event?: IssueEvent): Issue {
  return {
    ...issue,
    ...changes,
    updatedAt: new Date().toISOString(),
    events: event ? [...issue.events, event].sort((a, b) => a.at.localeCompare(b.at)) : issue.events,
  };
}

function apply(issues: readonly Issue[], id: string, change: (issue: Issue) => Issue): Issue[] {
  return issues.map((issue) => issue.id === id ? change(issue) : issue);
}

export function upsertIssue(issues: readonly Issue[], issue: Issue): Issue[] {
  const known = issues.some((item) => item.id === issue.id);
  return known ? issues.map((item) => item.id === issue.id ? issue : item) : [...issues, issue];
}

/** 手动挪一条（拖动、下拉框）。挪到别处就不再是「以后再验收」了。 */
export function withStatus(
  issues: readonly Issue[],
  id: string,
  status: IssueStatus,
  by: IssueEvent["by"] = "user",
): Issue[] {
  return apply(issues, id, (issue) => issue.status === status ? issue : patch(
    issue,
    { status, deferred: false },
    statusEvent(status, by, `移到「${ISSUE_STATUS_NAME[status]}」`),
  ));
}

/**
 * 打回重做：退回待处理，理由记进时间线。
 *
 * 用户说过这不该是一列，是一个动作——打回和「待回复」方向相反，混在一起谁都不知道
 * 该谁动了。理由也不该再单独问一遍，写在批阅界面的那个框里就是理由。
 */
export function rejectIssue(issues: readonly Issue[], id: string, reason: string): Issue[] {
  return apply(issues, id, (issue) => patch(
    issue,
    { status: "ready", deferred: false },
    statusEvent("ready", "user", reason.trim() ? `打回重做：${reason.trim()}` : "打回重做"),
  ));
}

/**
 * 留言。
 *
 * 它在「待回复」上等你拿主意，你一回复就自动回到待处理——这一步不该还要你再手动
 * 挪一次卡片。
 */
export function withComment(issues: readonly Issue[], id: string, text: string): Issue[] {
  return apply(issues, id, (issue) => issue.status === "reply"
    ? patch(issue, { status: "ready" }, { ...comment(text), kind: "comment" })
    : patch(issue, {}, comment(text)));
}

export function withEvent(issues: readonly Issue[], id: string, event: IssueEvent): Issue[] {
  return apply(issues, id, (issue) => patch(issue, {}, event));
}

/** 「以后再验收」：留在待验收那一列，但不再进批阅队列。 */
export function withDeferred(issues: readonly Issue[], id: string, deferred: boolean): Issue[] {
  return apply(issues, id, (issue) => patch(
    issue,
    { deferred },
    statusEvent(issue.status, "user", deferred ? "以后再验收" : "重新排进批阅"),
  ));
}

/** 删一条，连同它的子 Issue——留着孤儿只会在面板上挂着没人认得。 */
export function removeIssue(issues: readonly Issue[], id: string): Issue[] {
  return issues.filter((issue) => issue.id !== id && issue.parentId !== id);
}
