import type { SkillEntry } from "@coilcoil/runtime-protocol";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export function skillOverridePattern(filePath: string, baseDir: string): string {
  const pattern = relative(baseDir, filePath).split(sep).join("/");
  if (!pattern || pattern.startsWith("..")) return filePath;
  return pattern;
}

function withoutSkillOverride(paths: string[], pattern: string): string[] {
  return paths.filter((entry) => {
    const stripped = entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-") ? entry.slice(1) : entry;
    return stripped !== pattern;
  });
}

export function rewriteSkillOverridePaths(paths: string[], pattern: string, enabled: boolean): string[] {
  return [...withoutSkillOverride(paths, pattern), `${enabled ? "+" : "-"}${pattern}`];
}

export function removeSkillOverride(paths: string[], pattern: string): string[] {
  return [...withoutSkillOverride(paths, pattern), `!${pattern}`];
}

export function skillPatternBaseDir(
  skill: Pick<SkillEntry, "filePath" | "source" | "scope">,
  resolvedCwd: string,
  agentDir: string,
): string {
  if (skill.source === "agents") {
    let candidate = dirname(resolve(skill.filePath));
    while (dirname(candidate) !== candidate) {
      if (basename(candidate) === ".agents") return candidate;
      candidate = dirname(candidate);
    }
    return join(skill.scope === "project" ? resolvedCwd : homedir(), ".agents");
  }
  if (skill.scope === "project") return join(resolvedCwd, ".pi");
  return agentDir;
}

export function skillIsRemoved(
  skill: SkillEntry,
  resolvedCwd: string,
  agentDir: string,
  userPaths: string[],
  projectPaths: string[],
): boolean {
  const pattern = skillOverridePattern(skill.filePath, skillPatternBaseDir(skill, resolvedCwd, agentDir));
  const paths = skill.scope === "project" ? projectPaths : userPaths;
  return paths.includes(`!${pattern}`);
}
