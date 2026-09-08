import type { ProjectSelection, SessionSummary } from "@coilcoil/runtime-protocol";

export const DEFAULT_VISIBLE_SESSION_ROWS = 4;
export const SESSION_EXPANSION_BATCH = 4;

export function collapsedSessionLimit(hasPendingConversation: boolean): number {
  return DEFAULT_VISIBLE_SESSION_ROWS - (hasPendingConversation ? 1 : 0);
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
 * its conversations do.
 */
export function summarizeWorkspaceActivity(
  sessions: readonly SessionSummary[] | undefined,
  activity: Record<string, { running: boolean; unread: boolean } | undefined>,
): WorkspaceActivitySummary {
  let running = 0;
  let unread = 0;
  for (const session of sessions ?? []) {
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
 * Pinned conversations are included. They used to be filtered out here because
 * the pinned strip already lists them, but that made pinning a conversation
 * remove it from the workspace it belongs to — so the folder could say "1 个对话
 * 运行中" while every row under it sat still, and the conversation itself looked
 * lost rather than promoted. `collectRecentSessions` had the identical bug and
 * was fixed the same way; the project tree kept the old behaviour.
 *
 * The limit counts unpinned conversations only, for the same reason it does in
 * "recent": a pinned conversation is usually the one being worked in, and
 * letting it take one of four slots would push out the rows the folder exists to
 * show. The list stops at the last unpinned row that fits.
 */
export function visibleProjectSessions(
  sessions: readonly SessionSummary[],
  limit: number,
): ProjectSessionVisibility {
  const rows: SessionSummary[] = [];
  let shownPlain = 0;
  for (const session of sessions) {
    if (session.pinned) {
      rows.push(session);
      continue;
    }
    if (shownPlain >= limit) break;
    shownPlain += 1;
    rows.push(session);
  }
  const plainTotal = sessions.reduce((count, session) => session.pinned ? count : count + 1, 0);
  return { rows, hiddenCount: plainTotal - shownPlain, plainTotal };
}
