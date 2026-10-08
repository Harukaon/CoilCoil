import type {
  SaveSubagentProfileInput,
  SubagentProfileInfo,
  SubagentProfileModels,
  SubagentProfileScope,
  SubagentProfileSource,
  SubagentProfilesSnapshot,
} from "@coilcoil/runtime-protocol";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { require } from "./runtime-constants.js";
import { isRecord } from "./runtime-utils.js";

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
  ALLOWED_CHILD_TOOL_NAMES: readonly string[];
  isValidProfileName(name: string): boolean;
  serializeProfile(fields: {
    name: string;
    description?: string;
    model?: string;
    tools?: readonly string[];
    worktree?: boolean;
    systemPrompt?: string;
  }): string;
  loadProfiles(dirs: { builtinDir: string; userDir: string; projectDir?: string }): Map<string, WorkflowProfile>;
  loadProfilesFromDir(dir: string, source: SubagentProfileSource): WorkflowProfile[];
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

const MAX_DESCRIPTION_LENGTH = 400;
const MAX_PROMPT_LENGTH = 30_000;

function scopeDir(location: SubagentProfileLocation, scope: unknown): string {
  const dirs = subagentProfileDirs(location);
  if (scope === "user") return dirs.userDir;
  if (scope === "project") {
    if (!dirs.projectDir) throw new Error("没有打开项目，不能把子 Agent 保存到项目里。");
    return dirs.projectDir;
  }
  throw new Error("子 Agent 的保存位置无效。");
}

/**
 * Write a profile file the subagent tool will read back as written.
 *
 * Only what the settings form edits is rewritten; the `model:` a file already names is kept.
 * A name that belongs to a built-in profile is refused, and so is a file that exists but
 * does not parse as a profile: the first would quietly replace a profile that ships with
 * the product, the second would destroy something this code does not understand.
 */
export async function saveSubagentProfile(
  location: SubagentProfileLocation,
  input: SaveSubagentProfileInput,
): Promise<SubagentProfilesSnapshot> {
  const workflow = await loadWorkflowProfilesModule(location.workflowDir);
  if (!isRecord(input)) throw new Error("子 Agent 配置无效。");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!workflow.isValidProfileName(name)) {
    throw new Error("名字只能用小写字母、数字、- 和 _，以字母或数字开头，最长 48 个字符。");
  }
  const description = typeof input.description === "string" ? input.description.replace(/\s+/g, " ").trim() : "";
  if (!description) throw new Error("请写一句说明：主 Agent 靠它判断什么时候该派这个子 Agent。");
  if (description.length > MAX_DESCRIPTION_LENGTH) throw new Error(`说明太长了，最多 ${MAX_DESCRIPTION_LENGTH} 个字。`);
  const systemPrompt = typeof input.systemPrompt === "string" ? input.systemPrompt.trim() : "";
  if (!systemPrompt) throw new Error("请写提示词：它是这个子 Agent 全部的工作说明。");
  if (systemPrompt.length > MAX_PROMPT_LENGTH) throw new Error(`提示词太长了，最多 ${MAX_PROMPT_LENGTH} 个字。`);
  const tools = Array.isArray(input.tools) ? [...new Set(input.tools)] : [];
  if (tools.length === 0 || tools.some((tool) => typeof tool !== "string" || !workflow.ALLOWED_CHILD_TOOL_NAMES.includes(tool))) {
    throw new Error("请至少选一个工具，并且只能选列表里有的。");
  }

  const dir = scopeDir(location, input.scope);
  const existing = workflow.loadProfilesFromDir(dir, input.scope).find((profile) => profile.name === name);
  if (!existing) {
    const builtin = workflow.loadProfilesFromDir(subagentProfileDirs(location).builtinDir, "builtin").some((profile) => profile.name === name);
    if (builtin) throw new Error(`「${name}」是内置子 Agent 的名字，请换一个名字。`);
  }
  const path = existing?.filePath ?? join(dir, `${name}.md`);
  if (!existing && existsSync(path)) {
    throw new Error(`${path} 已经存在，但不是能识别的子 Agent 文件。请换一个名字，或先处理这个文件。`);
  }
  mkdirSync(dir, { recursive: true });
  const text = workflow.serializeProfile({ name, description, model: existing?.model, tools, worktree: input.worktree === true, systemPrompt });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, text, "utf8");
  renameSync(temporaryPath, path);
  return listSubagentProfiles(location);
}

/** Remove a profile the user wrote. The built-in ones are not in either folder, so they cannot be reached from here. */
export async function deleteSubagentProfile(
  location: SubagentProfileLocation,
  name: string,
  scope: SubagentProfileScope,
): Promise<SubagentProfilesSnapshot> {
  const workflow = await loadWorkflowProfilesModule(location.workflowDir);
  const dir = scopeDir(location, scope);
  const files = typeof name === "string"
    ? workflow.loadProfilesFromDir(dir, scope).filter((profile) => profile.name === name && profile.filePath)
    : [];
  if (files.length === 0) throw new Error(`没有找到要删除的子 Agent「${String(name)}」。`);
  for (const profile of files) unlinkSync(profile.filePath!);
  return listSubagentProfiles(location);
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
