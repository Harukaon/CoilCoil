import type { SessionSummary } from "@suocode/runtime-protocol";

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
