import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  PROJECT_MEMORY_MAX_CHARS,
  expandHome,
  type ProjectMemoryPaths,
} from "./memory-settings.ts";

const MEMORY_TEMPLATE = "";
const LOCK_WAIT_MS = 2_000;
const STALE_LOCK_MS = 30_000;

export interface EnforcedMemory {
  content: string;
}

export interface PersistedProjectMemoryState {
  version: 1;
  processedSessions: string[];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

export async function isInsidePiDirectory(cwd: string): Promise<boolean> {
  const canonical = await canonicalPath(cwd);
  const root = parse(canonical).root;
  return relative(root, canonical)
    .split(sep)
    .some((segment) => segment.toLowerCase() === ".pi");
}

export async function resolveProjectRoot(cwd: string): Promise<string> {
  const start = await canonicalPath(cwd);
  let current = start;
  while (true) {
    if (await pathExists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

export function resolveProjectMemoryStorageRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.PI_PROJECT_MEMORY_DIR?.trim();
  if (configured) return resolve(expandHome(configured));
  const agentDir = env.PI_CODING_AGENT_DIR?.trim()
    ? resolve(expandHome(env.PI_CODING_AGENT_DIR))
    : join(homedir(), ".pi", "agent");
  return join(agentDir, "memory");
}

export async function resolveProjectMemoryPaths(
  cwd: string,
  storageRoot = resolveProjectMemoryStorageRoot(),
): Promise<ProjectMemoryPaths> {
  const projectRoot = await resolveProjectRoot(cwd);
  const canonicalStorageRoot = resolve(storageRoot);
  const projectName = basename(projectRoot) || "root";
  const projectMemoryDir = join(canonicalStorageRoot, projectName);
  return {
    projectRoot,
    projectName,
    storageRoot: canonicalStorageRoot,
    memoryFile: join(projectMemoryDir, "MEMORY.md"),
    globalMemoryFile: join(canonicalStorageRoot, "GLOBAL.md"),
    projectMemoryDir,
    workerSessionsDir: join(projectMemoryDir, ".worker-sessions"),
    workerLockFile: join(projectMemoryDir, ".worker.lock"),
    runtimeStateFile: join(projectMemoryDir, ".suocode-memory-state.json"),
  };
}

export async function ensureFile(path: string, initialContent: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(initialContent, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  } finally {
    await handle?.close();
  }
}

export async function readUtf8(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function withFileLock<T>(
  targetPath: string,
  action: () => Promise<T>,
  options: { waitMs?: number; staleMs?: number } = {},
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + (options.waitMs ?? LOCK_WAIT_MS);
  const staleMs = options.staleMs ?? STALE_LOCK_MS;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > staleMs) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`等待记忆文件锁超时：${targetPath}`);
      await delay(40);
    }
  }
  try {
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function readPersistedMemoryState(
  paths: ProjectMemoryPaths,
): Promise<PersistedProjectMemoryState> {
  try {
    const parsed = JSON.parse(await readFile(paths.runtimeStateFile, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { version: 1, processedSessions: [] };
    }
    const values = (parsed as { processedSessions?: unknown }).processedSessions;
    const processedSessions = Array.isArray(values)
      ? values.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      : [];
    return { version: 1, processedSessions: [...new Set(processedSessions)] };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { version: 1, processedSessions: [] };
    return { version: 1, processedSessions: [] };
  }
}

export async function recordProcessedSession(
  paths: ProjectMemoryPaths,
  sessionFile: string,
): Promise<string[]> {
  return withFileLock(paths.runtimeStateFile, async () => {
    const current = await readPersistedMemoryState(paths);
    const processedSessions = [...new Set([...current.processedSessions, sessionFile])];
    await atomicWrite(
      paths.runtimeStateFile,
      `${JSON.stringify({ version: 1, processedSessions }, null, 2)}\n`,
    );
    return processedSessions;
  });
}

function migratedConflictName(name: string, content: string): string {
  const stem = basename(name, ".md").replace(/[^A-Za-z0-9._-]/g, "-") || "memory";
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 8);
  return `legacy-${stem}-${digest}.md`;
}

async function moveLegacyMarkdown(
  source: string,
  target: string,
  paths: ProjectMemoryPaths,
): Promise<void> {
  const sourceContent = await readUtf8(source);
  if (!(await pathExists(target))) {
    try {
      await rename(source, target);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EXDEV") throw error;
      await atomicWrite(target, sourceContent);
      await unlink(source).catch(() => undefined);
    }
    return;
  }
  if (await readUtf8(target) === sourceContent) {
    await unlink(source).catch(() => undefined);
    return;
  }
  const preserved = join(paths.projectMemoryDir, migratedConflictName(basename(source), sourceContent));
  await ensureFile(preserved, sourceContent);
  await unlink(source).catch(() => undefined);
}

async function migrateLegacyProjectMemory(paths: ProjectMemoryPaths): Promise<void> {
  const legacyProjectPiDir = join(paths.projectRoot, ".pi");
  const legacyMemoryFiles = [
    join(legacyProjectPiDir, "memory", "project", "MEMORY.md"),
    join(legacyProjectPiDir, "MEMORY.md"),
  ];
  const legacyDetailsRoots = [
    join(legacyProjectPiDir, "memory", "project"),
    join(legacyProjectPiDir, "memory"),
  ];
  await withFileLock(join(paths.projectMemoryDir, ".migration"), async () => {
    for (const legacyMemoryFile of legacyMemoryFiles) {
      if (await pathExists(legacyMemoryFile)) await moveLegacyMarkdown(legacyMemoryFile, paths.memoryFile, paths);
    }
    for (const legacyDetailsRoot of legacyDetailsRoots) {
      try {
        for (const entry of await readdir(legacyDetailsRoot, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "MEMORY.md") continue;
          await moveLegacyMarkdown(join(legacyDetailsRoot, entry.name), join(paths.projectMemoryDir, entry.name), paths);
        }
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
    }
    const current = await readUtf8(paths.memoryFile);
    if (current) {
      const migrated = current
        .replace(/\.pi\/memory\/(?:project\/)?([A-Za-z0-9][A-Za-z0-9._-]{0,79}\.md)/g, "$1")
        .replace("索引：.pi/memory/project/\n", MEMORY_TEMPLATE)
        .replace("索引：.pi/memory/\n", MEMORY_TEMPLATE);
      if (migrated !== current) await atomicWrite(paths.memoryFile, migrated);
    }
  });
}

export async function ensureProjectMemory(paths: ProjectMemoryPaths): Promise<void> {
  await mkdir(paths.storageRoot, { recursive: true, mode: 0o700 });
  await ensureFile(paths.globalMemoryFile, "");
  await mkdir(paths.projectMemoryDir, { recursive: true, mode: 0o700 });
  await migrateLegacyProjectMemory(paths);
  await ensureFile(paths.memoryFile, MEMORY_TEMPLATE);
}

export async function enforceProjectMemoryLimit(
  paths: ProjectMemoryPaths,
  _maximum = PROJECT_MEMORY_MAX_CHARS,
): Promise<EnforcedMemory> {
  await ensureProjectMemory(paths);
  return { content: await readUtf8(paths.memoryFile) };
}
