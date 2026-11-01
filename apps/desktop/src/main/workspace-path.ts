import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Match the runtime's workspace identity across macOS aliases and symlinks. */
export function canonicalWorkspacePath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    // Disconnected or removed workspaces remain mounted so the user can restore them.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return absolute;
    throw error;
  }
}
