import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ALLOWED_CHILD_TOOL_NAMES = ["read", "bash", "terminal", "edit", "write", "grep", "ls", "find", "mcp", "powershell"] as const;

export type SubagentProfileSource = "builtin" | "user" | "project";

export interface SubagentProfile {
  name: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  worktree?: boolean;
  source: SubagentProfileSource;
  filePath?: string;
}

interface FrontmatterValues {
  name?: string;
  description?: string;
  model?: string;
  worktree?: boolean;
  tools?: string[];
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseStringList(value: string): string[] {
  const inner = value.trim().startsWith("[") && value.trim().endsWith("]") ? value.trim().slice(1, -1) : value;
  return inner
    .split(",")
    .map((entry) => stripQuotes(entry))
    .filter((entry) => entry.length > 0);
}

export function parseProfileFile(text: string, source: SubagentProfileSource, filePath?: string): SubagentProfile | undefined {
  const normalized = text.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return undefined;
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const header = normalized.slice(3, end);
  const bodyStart = normalized.indexOf("\n", end + 1);
  const body = bodyStart === -1 ? "" : normalized.slice(bodyStart + 1).trim();

  const values: FrontmatterValues = {};
  for (const line of header.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;
    const separator = trimmedLine.indexOf(":");
    if (separator <= 0) continue;
    const key = trimmedLine.slice(0, separator).trim().toLowerCase();
    const rawValue = trimmedLine.slice(separator + 1).trim();
    if (!rawValue) continue;
    if (key === "name" || key === "description" || key === "model") {
      values[key] = stripQuotes(rawValue);
    } else if (key === "worktree") {
      values.worktree = rawValue === "true";
    } else if (key === "tools") {
      values.tools = parseStringList(rawValue);
    }
  }

  if (!values.name) return undefined;
  const invalidTools = values.tools?.filter((tool) => !(ALLOWED_CHILD_TOOL_NAMES as readonly string[]).includes(tool)) ?? [];
  if (invalidTools.length > 0) return undefined;

  return {
    name: values.name,
    description: values.description,
    model: values.model,
    worktree: values.worktree,
    tools: values.tools,
    systemPrompt: body || undefined,
    source,
    filePath,
  };
}

function loadProfilesFromDir(dir: string, source: SubagentProfileSource): SubagentProfile[] {
  if (!existsSync(dir)) return [];
  const profiles: SubagentProfile[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".md")) continue;
    const filePath = join(dir, name);
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const profile = parseProfileFile(text, source, filePath);
    if (profile) profiles.push(profile);
  }
  return profiles;
}

export interface ProfileDirs {
  builtinDir: string;
  userDir: string;
  projectDir: string;
}

export function loadProfiles(dirs: ProfileDirs): Map<string, SubagentProfile> {
  const merged = new Map<string, SubagentProfile>();
  for (const profile of loadProfilesFromDir(dirs.builtinDir, "builtin")) merged.set(profile.name, profile);
  for (const profile of loadProfilesFromDir(dirs.userDir, "user")) merged.set(profile.name, profile);
  for (const profile of loadProfilesFromDir(dirs.projectDir, "project")) merged.set(profile.name, profile);
  return merged;
}

/**
 * 列出 profile 给模型看。
 *
 * `resolveModel` 传进来时，没有配置模型的那几条会标成不可用——模型不能自己挑模型，
 * 用户没配就用不了。先在目录里说清楚，好过它派发一次再吃一个错误。
 */
export function formatProfileCatalog(
  profiles: Map<string, SubagentProfile>,
  resolveModel?: (profile: SubagentProfile) => string | undefined,
): string {
  if (profiles.size === 0) return "当前没有可用的子 Agent profile。";
  const lines = [...profiles.values()].map((profile) => {
    const model = resolveModel ? resolveModel(profile) : profile.model;
    const parts = [`- ${profile.name}`];
    if (profile.description) parts.push(`：${profile.description}`);
    if (resolveModel && !model) parts.push("（⚠ 未配置模型，当前不可用）");
    else if (model) parts.push(`（模型 ${model}）`);
    if (profile.tools?.length) parts.push(`（工具 ${profile.tools.join("/")}）`);
    return parts.join("");
  });
  return `子 Agent profile：\n${lines.join("\n")}`;
}
