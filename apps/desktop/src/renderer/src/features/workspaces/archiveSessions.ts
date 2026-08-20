import type { ProjectSelection, SessionSummary } from "@coilcoil/runtime-protocol";

/** How many archived rows a group shows before it asks to be expanded. */
export const ARCHIVE_ROW_BATCH = 8;

export interface ArchivedSessionGroup {
  project: ProjectSelection;
  sessions: SessionSummary[];
  /** Rows past `ARCHIVE_ROW_BATCH` that this group is holding back. */
  hidden: number;
  /** This project's archive has not been read yet. */
  pending: boolean;
}

/**
 * Which project the dialog reads when it opens.
 *
 * Reading every project's archive up front meant re-scanning every session file
 * of every project just to show a handful of rows, so only one project is read
 * eagerly and the rest wait until they are asked for.
 */
export function initialArchiveTarget(
  projects: ProjectSelection[],
  activeProject: ProjectSelection | null | undefined,
): string | undefined {
  if (activeProject && projects.some((project) => project.path === activeProject.path)) return activeProject.path;
  return projects[0]?.path;
}

/** The projects still worth requesting, given what is already loaded or in flight. */
export function pendingArchiveTargets(
  projects: ProjectSelection[],
  loaded: Record<string, SessionSummary[]>,
  inFlight: readonly string[],
): string[] {
  const busy = new Set(inFlight);
  return projects
    .map((project) => project.path)
    .filter((path) => !(path in loaded) && !busy.has(path));
}

export function filterArchivedSessionGroups(
  projects: ProjectSelection[],
  archives: Record<string, SessionSummary[]>,
  query: string,
  expanded: readonly string[] = [],
): ArchivedSessionGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  const opened = new Set(expanded);
  return projects.flatMap((project): ArchivedSessionGroup[] => {
    const loaded = archives[project.path];
    if (!loaded) return [{ project, sessions: [], hidden: 0, pending: true }];
    const matching = loaded.filter((session) => !needle || session.title.toLocaleLowerCase().includes(needle));
    if (!matching.length) return [];
    // A search is an explicit request to see everything that matches.
    const limit = needle || opened.has(project.path) ? matching.length : ARCHIVE_ROW_BATCH;
    return [{
      project,
      sessions: matching.slice(0, limit),
      hidden: Math.max(0, matching.length - limit),
      pending: false,
    }];
  });
}
