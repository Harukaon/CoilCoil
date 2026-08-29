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
 * Pinned conversations are included. They used to be filtered out because the
 * pinned section already lists them, but pinning a conversation then made it
 * vanish from "recent" - the one list you look at to find what you were just
 * doing - which reads as losing the conversation rather than promoting it.
 * How many of them fit on screen is {@link visibleRecentSessions}'s problem.
 *
 * The whole ordering is returned; the section shows as many rows as it is
 * expanded to.
 */
export function collectRecentSessions(
  projects: readonly ProjectSelection[],
  sessionsByProject: Record<string, SessionSummary[]>,
): RecentSessionEntry[] {
  return projects
    .flatMap((project) => (sessionsByProject[project.path] ?? [])
      .filter((session) => !session.archivedAt)
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

export interface RecentVisibility {
  /** The rows to render, still in time order. */
  rows: RecentSessionEntry[];
  /** How many unpinned conversations are still hidden; drives the "more" control. */
  hiddenCount: number;
}

/**
 * Cut the ordering down to what the section shows.
 *
 * The limit counts unpinned conversations only. Pinned ones ride along wherever
 * they land in time order without taking a slot, because they are the rows most
 * likely to be at the top - a pinned conversation is usually the one being
 * worked in - and letting them take slots would leave a four-row section that is
 * nothing but a second copy of the pinned block directly above it.
 *
 * The list stops at the last unpinned row that fits, so a pinned conversation
 * further down does not drag a stray row in behind the cut; it is still one
 * glance away in the pinned section.
 */
export function visibleRecentSessions(entries: readonly RecentSessionEntry[], limit: number): RecentVisibility {
  const rows: RecentSessionEntry[] = [];
  let shownPlain = 0;
  for (const entry of entries) {
    if (entry.session.pinned) {
      rows.push(entry);
      continue;
    }
    if (shownPlain >= limit) break;
    shownPlain += 1;
    rows.push(entry);
  }
  const plainTotal = entries.reduce((count, entry) => entry.session.pinned ? count : count + 1, 0);
  return { rows, hiddenCount: plainTotal - shownPlain };
}
