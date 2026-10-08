import type { SubagentProfileInfo, SubagentProfileModels } from "@coilcoil/runtime-protocol";

/**
 * What the settings pages say about the subagents that ship with the product.
 *
 * A profile's own description is written for the model that decides when to dispatch it,
 * so the built-in ones are in English. People reading this page get a short line in
 * Chinese instead. A profile the user wrote has no entry here and shows what they wrote.
 */
const BUILTIN_BLURBS: Record<string, string> = {
  explore: "只读搜索与代码梳理",
  worker: "编码实现与文件修改",
  reviewer: "独立代码评审",
  hacker: "自己设计用例，找出已完成代码里的问题",
};

export function subagentTitle(profile: Pick<SubagentProfileInfo, "name" | "source">): string {
  if (profile.source !== "builtin") return profile.name;
  return `${profile.name.charAt(0).toUpperCase()}${profile.name.slice(1)}`;
}

export function subagentBlurb(profile: Pick<SubagentProfileInfo, "name" | "source" | "description">): string {
  if (profile.source === "builtin") return BUILTIN_BLURBS[profile.name] ?? profile.description;
  return profile.description;
}

/** The model the user picked, or empty when none is picked. */
export function chosenSubagentModel(models: SubagentProfileModels, name: string): string {
  return Object.hasOwn(models, name) ? models[name]?.trim() ?? "" : "";
}

/**
 * Whether the subagent can be dispatched at all. A model picked here is enough, and so is
 * one written in the profile's own file; with neither, dispatching it is refused.
 */
export function subagentUsable(profile: Pick<SubagentProfileInfo, "name" | "fileModel">, models: SubagentProfileModels): boolean {
  return Boolean(chosenSubagentModel(models, profile.name) || profile.fileModel);
}

/** The models to send when saving: every listed profile, empty where nothing is picked, so a cleared choice sticks. */
export function subagentModelsToSave(profiles: readonly Pick<SubagentProfileInfo, "name">[], models: SubagentProfileModels): SubagentProfileModels {
  return Object.fromEntries(profiles.map((profile) => [profile.name, chosenSubagentModel(models, profile.name)]));
}
