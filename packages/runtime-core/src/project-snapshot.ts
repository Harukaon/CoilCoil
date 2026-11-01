import type { ProjectSnapshot } from "@coilcoil/runtime-protocol";
import type { ActiveSession } from "./runtime-state.js";

/** Refresh disk-derived fields together, so a successful scan clears any older scan error. */
export function projectSnapshot(
  active: Pick<ActiveSession, "cwd" | "project" | "terminals" | "planApproval">,
  scanned?: Pick<ProjectSnapshot, "files" | "changes" | "changesError">,
): ProjectSnapshot {
  const source = scanned ?? active.project;
  return {
    cwd: active.cwd,
    files: source.files,
    changes: source.changes,
    changesError: source.changesError,
    terminals: [...active.terminals.values()].sort((a, b) => b.startedAt - a.startedAt),
    planApproval: active.planApproval,
    refreshedAt: Date.now(),
  };
}
