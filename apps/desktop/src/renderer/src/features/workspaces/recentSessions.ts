import type { ProjectSelection, SessionSummary } from "@coilcoil/runtime-protocol";

export const RECENT_SECTION_COLLAPSED_KEY = "coilcoil.recent-section-collapsed";

/** How many rows the section shows before "more" is used. Kept short so the project tree stays in view. */
export const DEFAULT_RECENT_ROWS = 4;

export interface RecentSessionEntry {
  project: ProjectSelection;
  session: SessionSummary;
  /** The moment the row is sorted by: when this conversation last had activity. */
  at: number;
}

/**
 * The conversations to offer as "recent", newest first, across every workspace.
 *
 * Sorted by activity alone, deliberately. Counting "last opened" as recency
 * meant every click sent the row that was just clicked to the top, so the list
 * rearranged itself under the pointer and a conversation was never twice in the
 * same place. Ordering by the conversation's own last message instead leaves
 * positions stable between visits and moves a row only when something actually
 * happened in it.
 *
 * Pinned conversations are left out: they already have their own section above,
 * and a row that appears twice in one sidebar reads as two conversations. The
 * whole ordering is returned; the section shows as many rows as it is expanded to.
 */
export function collectRecentSessions(
  projects: readonly ProjectSelection[],
  sessionsByProject: Record<string, SessionSummary[]>,
): RecentSessionEntry[] {
  return projects
    .flatMap((project) => (sessionsByProject[project.path] ?? [])
      .filter((session) => !session.pinned && !session.archivedAt)
      .map((session) => ({ project, session, at: Date.parse(session.updatedAt) })))
    .filter((entry) => Number.isFinite(entry.at) && entry.at > 0)
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
