import type { SkillEntry } from "@suocode/runtime-protocol";

/**
 * Bundled skills ship with the runtime and cannot be turned on or off, so the
 * settings list hides them entirely rather than showing a dead control. Only
 * skills the user can actually manage are listed and counted.
 */
export function managedSkills(skills: SkillEntry[] | undefined): SkillEntry[] {
  return (skills ?? []).filter((skill) => skill.source !== "bundled");
}

export function skillEnabledCount(skills: SkillEntry[] | undefined): number {
  return managedSkills(skills).filter((skill) => skill.enabled).length;
}

export function skillCountLabel(skills: SkillEntry[] | undefined): string {
  const managed = managedSkills(skills);
  return `${managed.filter((skill) => skill.enabled).length}/${managed.length} 已启用`;
}

/**
 * A toggle button names the action it performs, not the state it is in — an
 * enabled skill offers "停用". Labelling it with its current state reads as the
 * opposite instruction and makes the highlight look like a status badge.
 */
export function skillToggleLabel(skill: Pick<SkillEntry, "enabled">): string {
  return skill.enabled ? "停用" : "启用";
}

export function skillToggleActionLabel(skill: Pick<SkillEntry, "enabled" | "name">): string {
  return `${skill.enabled ? "停用" : "启用"} ${skill.name}`;
}

/** Clicking a skill's toggle always requests the opposite of its current state. */
export function skillToggleTarget(skill: Pick<SkillEntry, "enabled">): boolean {
  return !skill.enabled;
}

/** Only skills copied into SuoCode's own user directory can be deleted here. */
export function canDeleteSkill(skill: Pick<SkillEntry, "source" | "scope" | "baseDir">, userSkillsDir?: string): boolean {
  if (skill.source !== "user" || skill.scope !== "user" || !userSkillsDir) return false;
  const root = userSkillsDir.replaceAll("\\", "/").replace(/\/+$/, "");
  const baseDir = skill.baseDir.replaceAll("\\", "/").replace(/\/+$/, "");
  return Boolean(root && baseDir && baseDir !== root && baseDir.startsWith(`${root}/`));
}
