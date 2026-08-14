import type { ProjectSelection, SessionSummary } from "@suocode/runtime-protocol";

export interface ArchivedSessionGroup {
  project: ProjectSelection;
  sessions: SessionSummary[];
}

export function filterArchivedSessionGroups(
  projects: ProjectSelection[],
  archives: Record<string, SessionSummary[]>,
  query: string,
): ArchivedSessionGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  return projects.flatMap((project) => {
    const sessions = (archives[project.path] ?? []).filter((session) => (
      !needle || session.title.toLocaleLowerCase().includes(needle)
    ));
    return sessions.length ? [{ project, sessions }] : [];
  });
}
