import { realpath, unlink } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildMemoryCountCommand } from "./project-memory.ts";

interface GuardConfig {
  sessionFile: string;
  memoryFile: string;
  requestedMemoryFile: string;
  detailsDir: string;
  lockFile?: string;
}

export interface MemoryWorkerGuardOptions {
  env?: NodeJS.ProcessEnv;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function canonicalExisting(path: string): Promise<string> {
  return realpath(resolve(path));
}

async function canonicalCandidate(path: string, cwd: string): Promise<string> {
  const absolute = resolve(cwd, path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }

  const suffix: string[] = [];
  let cursor = absolute;
  while (true) {
    const parent = dirname(cursor);
    if (parent === cursor) return absolute;
    suffix.unshift(basename(cursor));
    try {
      return resolve(await realpath(parent), ...suffix);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      cursor = parent;
    }
  }
}

function requiredPath(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`记忆守卫缺少环境变量 ${name}`);
  return resolve(value);
}

async function loadGuardConfig(env: NodeJS.ProcessEnv): Promise<GuardConfig> {
  const sessionFile = await canonicalExisting(
    requiredPath(env, "PI_MEMORY_WORKER_SESSION_FILE"),
  );
  const requestedMemoryFile = requiredPath(env, "PI_MEMORY_WORKER_MAIN_FILE");
  const memoryFile = await canonicalExisting(requestedMemoryFile);
  const detailsDir = await canonicalExisting(
    requiredPath(env, "PI_MEMORY_WORKER_DETAILS_DIR"),
  );
  const lockFile = env.PI_MEMORY_WORKER_LOCK_FILE?.trim();
  return {
    sessionFile,
    memoryFile,
    requestedMemoryFile,
    detailsDir,
    lockFile: lockFile ? resolve(lockFile) : undefined,
  };
}

function isInside(detailsDir: string, path: string): boolean {
  const child = relative(detailsDir, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

function isProjectMarkdown(detailsDir: string, path: string): boolean {
  return isInside(detailsDir, path) && path.toLowerCase().endsWith(".md");
}

function canRead(config: GuardConfig, path: string, toolName: string): boolean {
  if (path === config.sessionFile) return true;
  if (toolName === "grep" && isInside(config.detailsDir, path)) return true;
  return isProjectMarkdown(config.detailsDir, path);
}

function canWrite(config: GuardConfig, path: string): boolean {
  return isProjectMarkdown(config.detailsDir, path);
}

function shellQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function isMemoryCountCommand(command: string, memoryFiles: string[]): boolean {
  const normalized = command.trim();
  return memoryFiles.some((memoryFile) =>
    normalized === buildMemoryCountCommand(memoryFile) ||
    normalized === `wc -m < ${shellQuote(memoryFile)}` ||
    normalized === `wc -m ${JSON.stringify(memoryFile)}` ||
    normalized === `wc -m ${shellQuote(memoryFile)}`
  );
}

function blocked(reason: string): { block: true; reason: string } {
  return { block: true, reason: `记忆工作节点文件守卫：${reason}` };
}

export default function memoryWorkerGuard(
  pi: ExtensionAPI,
  options: MemoryWorkerGuardOptions = {},
): void {
  const env = options.env ?? process.env;
  const configPromise = loadGuardConfig(env);

  pi.on("tool_call", async (event, ctx) => {
    let config: GuardConfig;
    try {
      config = await configPromise;
    } catch (error) {
      return blocked(error instanceof Error ? error.message : String(error));
    }

    if (!["read", "grep", "write", "edit", "bash"].includes(event.toolName)) {
      return blocked(`工具 ${event.toolName} 不在允许列表中`);
    }

    const input = event.input as Record<string, unknown>;
    if (event.toolName === "bash") {
      const command = input.command;
      return typeof command === "string" && isMemoryCountCommand(command, [
          config.memoryFile,
          config.requestedMemoryFile,
        ])
        ? undefined
        : blocked("bash 只允许执行 MEMORY.md 的 wc -m 字符数检查");
    }

    const rawPath = input.path;
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      return blocked(`${event.toolName} 必须显式指定 path`);
    }

    let path: string;
    try {
      path = await canonicalCandidate(rawPath, ctx.cwd);
    } catch (error) {
      return blocked(`无法验证路径：${error instanceof Error ? error.message : String(error)}`);
    }

    if (event.toolName === "read" || event.toolName === "grep") {
      return canRead(config, path, event.toolName)
        ? undefined
        : blocked(`禁止读取 ${path}`);
    }

    if (!canWrite(config, path)) return blocked(`禁止修改 ${path}`);
    return undefined;
  });

  pi.on("session_shutdown", async () => {
    try {
      const config = await configPromise;
      if (config.lockFile) await unlink(config.lockFile).catch(() => undefined);
    } catch {
      // Invalid configuration already blocks every model tool call.
    }
  });
}
