import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { SkillConfigurationSnapshot } from "@coilcoil/runtime-protocol";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

function displayDiagnosticPath(sourcePath: string, diagnosticPath?: string): string {
  if (!diagnosticPath) return basename(sourcePath);
  const displayed = relative(sourcePath, diagnosticPath);
  return !displayed || displayed.startsWith("..") || isAbsolute(displayed)
    ? diagnosticPath
    : displayed;
}

export function validateSkillImport(sourcePath: string, cwd: string, agentDir: string): void {
  const result = loadSkills({
    cwd,
    agentDir,
    skillPaths: [sourcePath],
    includeDefaults: false,
  });
  if (!result.diagnostics.length && result.skills.length) return;

  const details = result.diagnostics.length
    ? result.diagnostics.map((item) => (
      `- ${displayDiagnosticPath(sourcePath, item.path)}：${item.message}`
    ))
    : [`- ${basename(sourcePath)}：没有找到可导入的 SKILL.md`];
  throw new Error(`技能目录校验失败，未导入：\n${details.join("\n")}`);
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function deleteInvalidManagedSkill(
  snapshot: SkillConfigurationSnapshot,
  filePath: string,
): boolean {
  const diagnostic = snapshot.diagnostics.find((item) => item.path === filePath);
  if (!diagnostic || snapshot.skills.some((skill) => skill.filePath === filePath)) return false;
  const managedRoot = realPath(snapshot.userSkillsDir);
  const skillRoot = realPath(dirname(filePath));
  const relativeRoot = relative(managedRoot, skillRoot);
  if (!relativeRoot || relativeRoot === ".." || relativeRoot.startsWith(`..${sep}`) || isAbsolute(relativeRoot)) {
    return false;
  }
  if (!existsSync(skillRoot)) return false;
  rmSync(skillRoot, { recursive: true, force: false });
  return true;
}
