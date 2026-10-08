import type {
  SubagentProfileInfo,
  SubagentProfileModels,
  SubagentProfileSource,
  SubagentProfilesSnapshot,
} from "@coilcoil/runtime-protocol";
import { join } from "node:path";
import { require } from "./runtime-constants.js";

/**
 * What the runtime lists, reads and writes for subagent profiles.
 *
 * The profile files belong to the workflow's subagent tool, which parses them when a
 * session starts. The parser lives there, in `extensions/subagents/profiles.ts`, and
 * this file loads that very module rather than keeping a second copy: a copy would
 * drift, and the settings page would then show — or write — something the tool reads
 * differently. The module only touches `node:fs` and `node:path`, so loading it does
 * not pull Pi in.
 */

interface WorkflowProfile {
  name: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  worktree?: boolean;
  source: SubagentProfileSource;
  filePath?: string;
}

interface WorkflowProfilesModule {
  DEFAULT_CHILD_TOOLS: readonly string[];
  loadProfiles(dirs: { builtinDir: string; userDir: string; projectDir?: string }): Map<string, WorkflowProfile>;
}

const workflowModules = new Map<string, Promise<WorkflowProfilesModule>>();

function loadWorkflowProfilesModule(workflowDir: string): Promise<WorkflowProfilesModule> {
  let loaded = workflowModules.get(workflowDir);
  if (!loaded) {
    const { createJiti } = require("jiti") as typeof import("jiti");
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    loaded = jiti.import(join(workflowDir, "extensions", "subagents", "profiles.ts")) as Promise<WorkflowProfilesModule>;
    // A failed load must not be remembered, or the settings page stays broken until restart.
    loaded.catch(() => workflowModules.delete(workflowDir));
    workflowModules.set(workflowDir, loaded);
  }
  return loaded;
}

export interface SubagentProfileLocation {
  workflowDir: string;
  agentDir: string;
  /** The open project, whose own profiles are listed too. */
  cwd?: string;
}

/** The three places profiles come from, in the order a later one overrides an earlier one. */
export function subagentProfileDirs(location: SubagentProfileLocation): { builtinDir: string; userDir: string; projectDir?: string } {
  return {
    builtinDir: join(location.workflowDir, "agents"),
    userDir: join(location.agentDir, "agents"),
    projectDir: location.cwd ? join(location.cwd, ".coilcoil", "agents") : undefined,
  };
}

const SOURCE_ORDER: Record<SubagentProfileSource, number> = { builtin: 0, user: 1, project: 2 };

function profileInfo(profile: WorkflowProfile, defaultTools: readonly string[]): SubagentProfileInfo {
  return {
    name: profile.name,
    description: profile.description ?? "",
    source: profile.source,
    filePath: profile.filePath ?? "",
    tools: [...(profile.tools ?? defaultTools)],
    worktree: profile.worktree === true,
    fileModel: profile.model?.trim() || undefined,
    systemPrompt: profile.systemPrompt ?? "",
  };
}

/** Every profile the subagent tool would see from this project, built-in ones first. */
export async function listSubagentProfiles(location: SubagentProfileLocation): Promise<SubagentProfilesSnapshot> {
  const workflow = await loadWorkflowProfilesModule(location.workflowDir);
  const merged = workflow.loadProfiles(subagentProfileDirs(location));
  const profiles = [...merged.values()]
    .map((profile) => profileInfo(profile, workflow.DEFAULT_CHILD_TOOLS))
    .sort((left, right) => SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source] || left.name.localeCompare(right.name));
  return { profiles, availableTools: [...workflow.DEFAULT_CHILD_TOOLS] };
}

/** Names a settings entry may use: not empty, not absurdly long, and nothing that rewrites an object's prototype. */
export function isSubagentModelKey(name: string): boolean {
  return name.length > 0 && name.length <= 80 && name !== "__proto__";
}

/** Profiles the short-lived single-`model` settings file used to cover. */
export const LEGACY_SINGLE_MODEL_PROFILES: readonly string[] = ["explore", "worker", "reviewer"];

/** Keep the chosen models that can be used: trimmed, non-empty, under a usable name. */
export function cleanSubagentModels(value: Record<string, unknown>): SubagentProfileModels {
  const models: SubagentProfileModels = {};
  for (const [name, model] of Object.entries(value)) {
    if (!isSubagentModelKey(name) || typeof model !== "string") continue;
    const trimmed = model.trim().slice(0, 200);
    if (trimmed) models[name] = trimmed;
  }
  return models;
}
