import { execFile } from "node:child_process";
import { chmod, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_SECRET_REFS = 8;
const SECRET_REGISTRY_NAME = "secret-refs.json";

export interface SecretEnvironmentInput {
  [environmentName: string]: string;
}

interface JsonSecretRef {
  source: "json";
  path: string;
  jsonPath: string;
}

interface EnvironmentSecretRef {
  source: "env";
  name: string;
}

interface KeychainSecretRef {
  source: "keychain";
  service: string;
  account: string;
}

type SecretRef = JsonSecretRef | EnvironmentSecretRef | KeychainSecretRef;

interface SecretRegistry {
  [handle: string]: SecretRef;
}

function registryPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, SECRET_REGISTRY_NAME);
}

function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(homedir(), value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSecretRef(value: unknown, handle: string): SecretRef {
  if (!isRecord(value) || typeof value.source !== "string") {
    throw new Error(`秘密引用无效：${handle}`);
  }

  if (value.source === "json") {
    if (typeof value.path !== "string" || typeof value.jsonPath !== "string") {
      throw new Error(`JSON 秘密引用缺少 path/jsonPath：${handle}`);
    }
    return { source: "json", path: value.path, jsonPath: value.jsonPath };
  }
  if (value.source === "env") {
    if (typeof value.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.name)) {
      throw new Error(`环境变量秘密引用无效：${handle}`);
    }
    return { source: "env", name: value.name };
  }
  if (value.source === "keychain") {
    if (typeof value.service !== "string" || typeof value.account !== "string") {
      throw new Error(`Keychain 秘密引用缺少 service/account：${handle}`);
    }
    return { source: "keychain", service: value.service, account: value.account };
  }

  throw new Error(`不支持的秘密引用类型：${handle}`);
}

async function loadRegistry(): Promise<SecretRegistry> {
  const path = registryPath();
  let raw: string;
  try {
    const details = await stat(path);
    if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
      throw new Error(`秘密引用文件权限过宽（需要 600）：${path}`);
    }
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && error.message.includes("权限过宽")) throw error;
    throw new Error(
      `找不到秘密引用配置：${path}。请先创建它，不要把秘密值写入配置。`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`秘密引用配置不是有效 JSON：${path}`);
  }
  if (!isRecord(parsed)) throw new Error(`秘密引用配置必须是对象：${path}`);

  const registry: SecretRegistry = {};
  for (const [handle, value] of Object.entries(parsed)) {
    registry[handle] = parseSecretRef(value, handle);
  }
  return registry;
}

function readJsonPath(value: unknown, jsonPath: string): unknown {
  let current = value;
  for (const segment of jsonPath.split(".").filter(Boolean)) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

async function resolveSecretRef(ref: SecretRef): Promise<string> {
  if (ref.source === "env") {
    const value = process.env[ref.name];
    if (!value) throw new Error(`秘密环境变量未设置：${ref.name}`);
    return value;
  }

  if (ref.source === "json") {
    const path = expandUserPath(ref.path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new Error(`无法读取 JSON 秘密来源：${path}`);
    }
    const value = readJsonPath(parsed, ref.jsonPath);
    if (typeof value !== "string" || !value) {
      throw new Error(`JSON 秘密字段不存在或为空：${ref.jsonPath}`);
    }
    return value;
  }

  if (process.platform !== "darwin") {
    throw new Error("keychain 秘密引用目前只支持 macOS");
  }
  try {
    const result = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-s", ref.service, "-a", ref.account, "-w"],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 },
    );
    const value = String(result.stdout).trim();
    if (!value) throw new Error("empty keychain value");
    return value;
  } catch {
    throw new Error(`无法读取 macOS Keychain 秘密：${ref.service}/${ref.account}`);
  }
}

export async function resolveSecretEnvironment(
  input: SecretEnvironmentInput | undefined,
): Promise<{ values: Record<string, string>; handles: string[] }> {
  if (!input || Object.keys(input).length === 0) {
    return { values: {}, handles: [] };
  }
  const entries = Object.entries(input);
  if (entries.length > MAX_SECRET_REFS) {
    throw new Error(`一次最多注入 ${MAX_SECRET_REFS} 个秘密引用`);
  }

  const registry = await loadRegistry();
  const values: Record<string, string> = {};
  const handles: string[] = [];
  for (const [environmentName, handle] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName)) {
      throw new Error(`无效的秘密环境变量名：${environmentName}`);
    }
    const ref = registry[handle];
    if (!ref) throw new Error(`未登记的秘密引用：${handle}`);
    values[environmentName] = await resolveSecretRef(ref);
    handles.push(handle);
  }
  return { values, handles };
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

export function secretRegistryFilePath(): string {
  return registryPath();
}

// Kept as a small explicit helper for future setup commands. It never writes
// secret values; callers may use it to ensure the registry's mode is private.
export async function ensureRegistryPrivate(path = registryPath()): Promise<void> {
  if (process.platform === "win32") return;
  await chmod(path, 0o600);
}
