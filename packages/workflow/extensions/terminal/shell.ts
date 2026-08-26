import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface TerminalShell {
  shell: string;
  args(command: string): string[];
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const search = env.PATH ?? env.Path;
  if (!search) return undefined;
  for (const directory of search.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The shell the terminal tool runs commands in.
 *
 * This deliberately ignores `$SHELL`. The tool is described to the Agent as a
 * Bash shell, so a machine whose login shell is fish or nushell would silently
 * reject the syntax the Agent writes. `$SHELL` also varies by how CoilCoil was
 * started — a terminal launch inherits it, a Finder launch does not — which
 * made the same build run commands under different shells. On Windows it was
 * worse: a `$SHELL` left behind by Git Bash was spawned with PowerShell's own
 * flags. A fixed shell keeps every launch identical.
 */
export function resolveTerminalShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): TerminalShell {
  if (platform === "win32") {
    const shell = findOnPath("pwsh.exe", env) ?? "powershell.exe";
    return { shell, args: (command) => ["-NoLogo", "-Command", command] };
  }
  const bash = existsSync("/bin/bash") ? "/bin/bash" : findOnPath("bash", env);
  return { shell: bash ?? "/bin/sh", args: (command) => ["-lc", command] };
}

let cached: TerminalShell | undefined;

export function terminalShell(): TerminalShell {
  cached ??= resolveTerminalShell();
  return cached;
}
