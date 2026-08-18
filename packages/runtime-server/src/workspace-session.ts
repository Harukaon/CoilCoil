import type { SessionSnapshot, SessionSummary } from "@suocode/runtime-protocol";

export function selectWorkspaceSessionPath(
  sessions: SessionSummary[],
  current: SessionSnapshot | undefined,
  cwd: string,
  normalize: (path: string) => string,
): string | undefined {
  if (current && normalize(current.session.cwd) === normalize(cwd)) {
    const selected = sessions.find((session) => normalize(session.path) === normalize(current.session.path));
    if (selected) return selected.path;
  }
  return undefined;
}
