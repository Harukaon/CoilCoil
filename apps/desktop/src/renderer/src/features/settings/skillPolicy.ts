import type { SkillEntry } from "@coilcoil/runtime-protocol";

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
 * What the row says about itself.
 *
 * This used to be a button labelled with the action it performs — an enabled
 * skill offering "停用" — which is the one label that reads as the opposite of
 * the truth at a glance. The control is a switch now, so the words state the
 * skill's condition and the switch carries the action.
 */
export function skillStateLabel(skill: Pick<SkillEntry, "enabled">): string {
  return skill.enabled ? "已启用" : "已停用";
}

/**
 * A switch is named by what it controls, never by the state it is in: screen
 * readers announce "on"/"off" from aria-checked, and a label that flips with the
 * state would contradict it.
 */
export function skillSwitchLabel(skill: Pick<SkillEntry, "name">): string {
  return `启用 ${skill.name}`;
}

/** Clicking a skill's toggle always requests the opposite of its current state. */
export function skillToggleTarget(skill: Pick<SkillEntry, "enabled">): boolean {
  return !skill.enabled;
}

/** Only skills copied into CoilCoil's own user directory can be deleted here. */
export function canDeleteSkill(skill: Pick<SkillEntry, "source" | "scope" | "baseDir">, userSkillsDir?: string): boolean {
  if (skill.source !== "user" || skill.scope !== "user" || !userSkillsDir) return false;
  const root = userSkillsDir.replaceAll("\\", "/").replace(/\/+$/, "");
  const baseDir = skill.baseDir.replaceAll("\\", "/").replace(/\/+$/, "");
  return Boolean(root && baseDir && baseDir !== root && baseDir.startsWith(`${root}/`));
}

/** External and project skill imports can be removed without touching their source directory. */
export function canRemoveSkill(skill: Pick<SkillEntry, "source">): boolean {
  return skill.source !== "bundled";
}
