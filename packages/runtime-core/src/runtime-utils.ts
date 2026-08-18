import {
  existsSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import {
  MASKED_CONFIGURATION_VALUE
} from "./runtime-constants.js";

export function recordOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function stripJsonComments(value: string): string {
  let output = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];
    if (quoted) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      index += 1;
      while (index + 1 < value.length && value[index + 1] !== "\n" && value[index + 1] !== "\r") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < value.length && !(value[index] === "*" && value[index + 1] === "/")) index += 1;
      if (index < value.length) index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

export function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" && record[key].trim() ? record[key] : undefined;
}

export function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

export function optionalPositiveNumber(record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === "number" && Number.isFinite(record[key]) && record[key] > 0 ? record[key] : undefined;
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function stringRecord(value: unknown, redact = false): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  if (!entries.length) return undefined;
  return Object.fromEntries(entries.map(([key, entry]) => [key, redact && sensitiveConfigurationKey(key) && entry ? MASKED_CONFIGURATION_VALUE : entry]));
}

export function safeUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? cloneJson(value) : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorDetail(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

export function estimatedTextTokens(value: unknown): number {
  if (typeof value === "string") return Math.ceil(value.length / 4);
  try {
    return Math.ceil(JSON.stringify(value).length / 4);
  } catch {
    return 0;
  }
}

export function clampText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… output truncated …`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function sensitiveConfigurationKey(key: string): boolean {
  return /(?:authorization|api[-_]?key|token|secret|password|cookie|credential)/i.test(key);
}

export function safeRealPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const missingSegments: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    missingSegments.unshift(basename(existing));
    existing = parent;
  }
  try {
    return resolve(realpathSync(existing), ...missingSegments);
  } catch {
    return absolute;
  }
}

export function ensureInside(root: string, path: string): string {
  const resolvedRoot = safeRealPath(root);
  const candidate = isAbsolute(path) ? resolve(path) : resolve(resolvedRoot, path);
  const target = safeRealPath(candidate);
  const rel = relative(resolvedRoot, target);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("请求的文件不在当前项目中。");
  }
  return target;
}
