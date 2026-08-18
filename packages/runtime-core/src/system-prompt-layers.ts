import { existsSync } from "node:fs";
import { join } from "node:path";

function existing(paths: string[]): string[] {
  return paths.filter((path) => existsSync(path));
}

export function systemPromptLayerFiles({
  agentDir,
  cwd,
  projectTrusted,
}: {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
}): string[] {
  const globalLayers = existing([
    join(agentDir, "SYSTEM.md"),
    join(agentDir, "APPEND_SYSTEM.md"),
  ]);
  if (!projectTrusted) return globalLayers;
  return [
    ...globalLayers,
    ...existing([
      join(cwd, ".pi", "SYSTEM.md"),
      join(cwd, ".pi", "APPEND_SYSTEM.md"),
    ]),
  ];
}
