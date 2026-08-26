import type { ProjectSelection, SessionSummary } from "@coilcoil/runtime-protocol";

export const RECENT_OPENS_STORAGE_KEY = "coilcoil.recent-conversation-opens";
export const RECENT_SECTION_COLLAPSED_KEY = "coilcoil.recent-section-collapsed";

/** How many rows the section shows before "more" is used. Kept short so the project tree stays in view. */
export const DEFAULT_RECENT_ROWS = 4;
/** More opens are remembered than shown, so a conversation dropping off the list can come back. */
const REMEMBERED_OPENS = 40;

/** Conversation path → when it was last opened, ISO. */
export type RecentOpens = Record<string, string>;

export function loadRecentOpens(): RecentOpens {
  try {
    const stored = window.localStorage.getItem(RECENT_OPENS_STORAGE_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && Number.isFinite(Date.parse(entry[1])));
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function saveRecentOpens(opens: RecentOpens): void {
  try {
    window.localStorage.setItem(RECENT_OPENS_STORAGE_KEY, JSON.stringify(opens));
  } catch {
    // A full or unavailable localStorage costs the ordering, not the session.
  }
}

/**
 * Remember that a conversation was opened, keeping only the newest opens.
 *
 * Opening is half of "recent": a conversation read but not written to never
 * moves its `updatedAt`, and it is exactly the one a user goes looking for
 * again.
 */
export function recordRecentOpen(current: RecentOpens, sessionPath: string, at: Date = new Date()): RecentOpens {
  if (!sessionPath) return current;
  const next = Object.entries({ ...current, [sessionPath]: at.toISOString() })
    .sort((left, right) => Date.parse(right[1]) - Date.parse(left[1]))
    .slice(0, REMEMBERED_OPENS);
  return Object.fromEntries(next);
}

export interface RecentSessionEntry {
  project: ProjectSelection;
  session: SessionSummary;
  /** The moment the row is sorted by: the later of its last open and its last activity. */
  at: number;
}

function lastTouched(session: SessionSummary, opens: RecentOpens): number {
  const updated = Date.parse(session.updatedAt);
  const opened = Date.parse(opens[session.path] ?? "");
  return Math.max(Number.isFinite(updated) ? updated : 0, Number.isFinite(opened) ? opened : 0);
}

/**
 * The conversations to offer as "recent", newest first, across every workspace.
 *
 * Pinned conversations are left out: they already have their own section above,
 * and a row that appears twice in one sidebar reads as two conversations. The
 * whole ordering is returned; the section shows as many rows as it is expanded to.
 */
export function collectRecentSessions(
  projects: readonly ProjectSelection[],
  sessionsByProject: Record<string, SessionSummary[]>,
  opens: RecentOpens,
): RecentSessionEntry[] {
  return projects
    .flatMap((project) => (sessionsByProject[project.path] ?? [])
      .filter((session) => !session.pinned && !session.archivedAt)
      .map((session) => ({ project, session, at: lastTouched(session, opens) })))
    .filter((entry) => entry.at > 0)
    .sort((left, right) => right.at - left.at);
}

export function loadRecentSectionCollapsed(): boolean {
  try {
    return window.localStorage.getItem(RECENT_SECTION_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveRecentSectionCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(RECENT_SECTION_COLLAPSED_KEY, collapsed ? "true" : "false");
  } catch {
    // Losing the preference is not worth failing the click over.
  }
}
