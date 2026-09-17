import type { ProjectSelection, SessionSummary } from "@coilcoil/runtime-protocol";

export const DEFAULT_VISIBLE_SESSION_ROWS = 4;
export const SESSION_EXPANSION_BATCH = 4;

/* 从前这里要给「新对话」那一行让出一格，所以带一个 hasPendingConversation 参数。
   那一行已经不画了，折叠时就是固定的四行。 */
export function collapsedSessionLimit(): number {
  return DEFAULT_VISIBLE_SESSION_ROWS;
}

export function nextExpandedSessionLimit(currentVisible: number, total: number): number {
  return Math.min(total, currentVisible + SESSION_EXPANSION_BATCH);
}

export function titleFromPrompt(text: string, hasImages: boolean): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return hasImages ? "图片对话" : "新建对话";
  return oneLine.length > 64 ? `${oneLine.slice(0, 61)}…` : oneLine;
}

export function upsertSessionSummary(sessions: SessionSummary[], session: SessionSummary): SessionSummary[] {
  const next = [session, ...sessions.filter((item) => item.path !== session.path && item.id !== session.id)];
  return next.sort((left, right) => {
    if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

/**
 * 归档掉当前这条之后，该轮到哪一条。
 *
 * 取紧挨着的下一条；被归档的是最后一条就取上一条；整个工作区空了就返回
 * undefined，由调用方落到空白状态。原来这里一律弹一个「新对话」出来——归档一条
 * 旧对话并不表示要开新的，用户的话是「直接默认选中下一个不就好了…如果没有下一个
 * 可选，就显示一个空白」。
 *
 * 传进来的是归档前的那份列表：只有它还留着被归档那条的位置，才谈得上「下一条」。
 */
export function nextSelectionAfterArchive(
  previous: readonly SessionSummary[],
  archivedPath: string,
): SessionSummary | undefined {
  const index = previous.findIndex((session) => session.path === archivedPath);
  if (index === -1) return undefined;
  const remaining = previous.filter((session) => session.path !== archivedPath);
  if (!remaining.length) return undefined;
  return remaining[Math.min(index, remaining.length - 1)];
}

export interface PinnedSessionEntry {
  project: ProjectSelection;
  session: SessionSummary;
}

/** Pinned conversations are shown in one global section, while retaining their workspace owner. */
export function collectPinnedSessions(
  projects: ProjectSelection[],
  sessionsByProject: Record<string, SessionSummary[]>,
): PinnedSessionEntry[] {
  return projects.flatMap((project) => (sessionsByProject[project.path] ?? [])
    .filter((session) => session.pinned)
    .map((session) => ({ project, session })))
    .sort((left, right) => Date.parse(right.session.pinnedAt ?? right.session.updatedAt) - Date.parse(left.session.pinnedAt ?? left.session.updatedAt));
}

export interface WorkspaceActivitySummary {
  running: number;
  /** Finished while the user was looking somewhere else. */
  unread: number;
}

/**
 * Roll a workspace's conversations up into one indicator.
 *
 * A running conversation inside a collapsed workspace is otherwise invisible,
 * which is how a long job gets forgotten. The folder row carries the same state
 * its conversations do — the ones it still holds, that is: a pinned conversation
 * has left for the strip at the top and reports for itself there.
 */
export function summarizeWorkspaceActivity(
  sessions: readonly SessionSummary[] | undefined,
  activity: Record<string, { running: boolean; unread: boolean } | undefined>,
): WorkspaceActivitySummary {
  let running = 0;
  let unread = 0;
  for (const session of sessions ?? []) {
    // 置顶的对话已经不在这个文件夹底下了，它自己那一行会说它在跑。再算进文件夹
    // 的角标，就成了「1 个对话运行中」底下一行都没有。
    if (session.pinned) continue;
    const state = session.path ? activity[session.path] : undefined;
    if (!state) continue;
    if (state.running) running += 1;
    else if (state.unread) unread += 1;
  }
  return { running, unread };
}

/** What the folder row should show, or nothing when the workspace is quiet. */
export function workspaceActivityLabel(summary: WorkspaceActivitySummary): string | undefined {
  if (summary.running) return `${summary.running} 个对话运行中`;
  if (summary.unread) return `${summary.unread} 个对话有新回复`;
  return undefined;
}

/**
 * 有多少个对话「回复完了但还没看」——Dock 角标上的那个数字。
 *
 * 只数未读，不数运行中：角标是「有几件事等着你处理」，还在跑的那些不需要你做
 * 任何事。跨所有工作区累计，因为 Dock 图标只有一个，看的人也不在某个工作区里。
 */
export function unreadConversationCount(activity: Record<string, { running: boolean; unread: boolean }>): number {
  let unread = 0;
  for (const state of Object.values(activity)) {
    if (state && !state.running && state.unread) unread += 1;
  }
  return unread;
}

export type ConversationStatusKind = "running" | "unread" | "pinned" | "none";

/**
 * Which marker a conversation row carries.
 *
 * Running beats unread beats the pin. What a row most needs to say is whether
 * the agent is still working, and then whether what it finished has been read;
 * the pin is only worth a slot when nothing is happening, and in the pinned
 * section it is the least surprising thing about the row anyway.
 */
export function conversationStatusKind(
  activity: { running: boolean; unread: boolean } | undefined,
  pinned: boolean,
): ConversationStatusKind {
  if (activity?.running) return "running";
  if (activity?.unread) return "unread";
  return pinned ? "pinned" : "none";
}

export interface ProjectSessionVisibility {
  /** The rows to render, in the order the listing already put them. */
  rows: SessionSummary[];
  /** How many unpinned conversations are still hidden; drives the "more" control. */
  hiddenCount: number;
  /** How many unpinned conversations the workspace has in total. */
  plainTotal: number;
}

/**
 * Cut a workspace's conversations down to what its folder shows.
 *
 * Pinning moves a conversation out of its folder and into the strip at the top.
 * It is listed once, in one place, and the strip names the workspace it came
 * from — which is what makes the move legible rather than a disappearance.
 *
 * This has been both ways. Listing a pinned conversation in the folder as well
 * was meant to stop it "vanishing" when pinned, but living with it, the
 * duplicate is what reads as wrong: 「置顶了，就可以从他们的文件夹里面移除了…
 * 体验下来不符合逻辑」. A pin is a move, not a copy.
 */
export function visibleProjectSessions(
  sessions: readonly SessionSummary[],
  limit: number,
): ProjectSessionVisibility {
  const plain = sessions.filter((session) => !session.pinned);
  const rows = plain.slice(0, Math.max(0, limit));
  return { rows, hiddenCount: plain.length - rows.length, plainTotal: plain.length };
}
