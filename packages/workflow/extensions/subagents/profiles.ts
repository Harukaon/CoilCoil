import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ALLOWED_CHILD_TOOL_NAMES = ["read", "bash", "terminal", "edit", "write", "grep", "ls", "find", "mcp", "powershell"] as const;

/** What a profile that does not list its own `tools` gets. */
export const DEFAULT_CHILD_TOOLS: readonly string[] = ["read", "bash", "terminal", "edit", "write", "grep", "ls", "mcp"];

/**
 * Names the settings page accepts for a new profile: lowercase, no spaces, safe as a
 * file name. Profiles written by hand may use any name; this only guards what we write.
 */
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** Windows will not create a file with one of these names, whatever its extension. */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_PATTERN.test(name) && !WINDOWS_RESERVED_NAMES.test(name);
}

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

export interface ProfileFileFields {
  name: string;
  description?: string;
  model?: string;
  tools?: readonly string[];
  worktree?: boolean;
  systemPrompt?: string;
}

/**
 * The inverse of `parseProfileFile`: the text to write so the same profile reads back.
 *
 * The frontmatter is one `key: value` per line, so a description is flattened to one
 * line. It is always quoted, because the parser strips one pair of outer quotes and a
 * description that happens to start and end with a quote would otherwise lose them.
 */
export function serializeProfile(fields: ProfileFileFields): string {
  const lines = ["---", `name: ${fields.name}`];
  const description = (fields.description ?? "").replace(/\s+/g, " ").trim();
  if (description) lines.push(`description: "${description}"`);
  const model = (fields.model ?? "").trim();
  if (model) lines.push(`model: ${model}`);
  if (fields.tools) lines.push(`tools: [${fields.tools.join(", ")}]`);
  if (fields.worktree) lines.push("worktree: true");
  lines.push("---");
  const body = (fields.systemPrompt ?? "").trim();
  return `${lines.join("\n")}\n${body ? `\n${body}\n` : ""}`;
}

/** The profiles in one folder, in file-name order. A file that does not parse is skipped. */
export function loadProfilesFromDir(dir: string, source: SubagentProfileSource): SubagentProfile[] {
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
  /** Absent when no project is open, e.g. while the settings page is open on its own. */
  projectDir?: string;
}

export function loadProfiles(dirs: ProfileDirs): Map<string, SubagentProfile> {
  const merged = new Map<string, SubagentProfile>();
  for (const profile of loadProfilesFromDir(dirs.builtinDir, "builtin")) merged.set(profile.name, profile);
  for (const profile of loadProfilesFromDir(dirs.userDir, "user")) merged.set(profile.name, profile);
  if (dirs.projectDir) {
    for (const profile of loadProfilesFromDir(dirs.projectDir, "project")) merged.set(profile.name, profile);
  }
  return merged;
}

const CUSTOM_CATALOG_LIMIT = 20;
const CUSTOM_CATALOG_DESCRIPTION_LIMIT = 200;

/**
 * The sentence of the subagent tool's description that names the profiles the user added.
 *
 * The built-in profiles are described there in prose already. A profile someone wrote is
 * something the main agent could not otherwise know exists, so it is named with its own
 * description, which is what the author wrote it for. Only profiles that can be dispatched
 * are named: one with no model chosen would be refused, so naming it invites a failed call.
 * Descriptions are cut to one short line (a project's files are not necessarily the user's
 * own). Returns "" when there is nothing to say, so a session without custom profiles keeps
 * exactly the description it had.
 */
export function formatCustomProfiles(
  profiles: Map<string, SubagentProfile>,
  usable: (profile: SubagentProfile) => boolean,
): string {
  const custom = [...profiles.values()]
    .filter((profile) => profile.source !== "builtin" && usable(profile))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (custom.length === 0) return "";
  const entries = custom.slice(0, CUSTOM_CATALOG_LIMIT).map((profile) => {
    const text = (profile.description ?? "").replace(/\s+/g, " ").trim();
    const shown = text.length > CUSTOM_CATALOG_DESCRIPTION_LIMIT ? `${text.slice(0, CUSTOM_CATALOG_DESCRIPTION_LIMIT - 1)}…` : text;
    return `${profile.name}${profile.source === "project" ? " (from this project)" : ""}: ${shown || "no description"}`;
  });
  const rest = custom.length - entries.length;
  return `Subagents the user added, dispatch them by name: ${entries.join("; ")}${rest > 0 ? `; and ${rest} more, listed by action=status` : ""}.`;
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
