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
import {
  MEMORY_ENTRIES_DIRNAME,
  isMemoryIndex,
  memoryEntryFileName,
  memoryEntryPath,
  parseMemoryIndex,
  renderMemoryIndex,
  splitLegacyMemory,
  summarizeMemoryBody,
  type MemoryIndexEntry,
} from "./memory-index.ts";

const MEMORY_TEMPLATE = "";
const LOCK_WAIT_MS = 2_000;
const STALE_LOCK_MS = 30_000;

export interface EnforcedMemory {
  content: string;
}

export interface PersistedProjectMemoryState {
  version: 1;
  processedSessions: string[];
  /** 上次整理之后又结束了多少轮回复；到达配置的间隔才会再跑一次后台整理。 */
  turnsSinceSummary: number;
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

/**
 * 记忆跟着工作区文件夹走，和 git 无关：导入哪个文件夹，记忆就是哪个文件夹的。
 * 父文件夹是 git 仓库也不往上找——子文件夹单独导入，就是一个单独的项目。
 */
export async function resolveProjectRoot(cwd: string): Promise<string> {
  return canonicalPath(cwd);
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
    entriesDir: join(projectMemoryDir, MEMORY_ENTRIES_DIRNAME),
    workerSessionsDir: join(projectMemoryDir, ".worker-sessions"),
    workerLockFile: join(projectMemoryDir, ".worker.lock"),
    runtimeStateFile: join(projectMemoryDir, ".coilcoil-memory-state.json"),
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
  const empty: PersistedProjectMemoryState = { version: 1, processedSessions: [], turnsSinceSummary: 0 };
  try {
    const parsed = JSON.parse(await readFile(paths.runtimeStateFile, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
    const record = parsed as { processedSessions?: unknown; turnsSinceSummary?: unknown };
    const values = record.processedSessions;
    const processedSessions = Array.isArray(values)
      ? values.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      : [];
    const turns = record.turnsSinceSummary;
    return {
      version: 1,
      processedSessions: [...new Set(processedSessions)],
      turnsSinceSummary: typeof turns === "number" && Number.isFinite(turns) && turns > 0
        ? Math.floor(turns)
        : 0,
    };
  } catch {
    return empty;
  }
}

async function writePersistedMemoryState(
  paths: ProjectMemoryPaths,
  state: PersistedProjectMemoryState,
): Promise<void> {
  await atomicWrite(paths.runtimeStateFile, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * 记一轮，并返回累计轮数。
 *
 * 计数落在项目记忆目录里而不是进程内存里：同一个项目可能同时开着多个会话，
 * 应用也会重启，只有写进文件才是「这个项目一共又聊了多少轮」。
 */
export async function recordMemoryTurn(paths: ProjectMemoryPaths): Promise<number> {
  await mkdir(paths.projectMemoryDir, { recursive: true, mode: 0o700 });
  return withFileLock(paths.runtimeStateFile, async () => {
    const current = await readPersistedMemoryState(paths);
    const turnsSinceSummary = current.turnsSinceSummary + 1;
    await writePersistedMemoryState(paths, { ...current, turnsSinceSummary });
    return turnsSinceSummary;
  });
}

export async function resetMemoryTurns(paths: ProjectMemoryPaths): Promise<void> {
  await withFileLock(paths.runtimeStateFile, async () => {
    const current = await readPersistedMemoryState(paths);
    if (current.turnsSinceSummary === 0) return;
    await writePersistedMemoryState(paths, { ...current, turnsSinceSummary: 0 });
  });
}

export async function recordProcessedSession(
  paths: ProjectMemoryPaths,
  sessionFile: string,
): Promise<string[]> {
  return withFileLock(paths.runtimeStateFile, async () => {
    const current = await readPersistedMemoryState(paths);
    const processedSessions = [...new Set([...current.processedSessions, sessionFile])];
    await writePersistedMemoryState(paths, { ...current, processedSessions });
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

/** 项目记忆目录里已有的正文文件名，按名字排序，作为索引之外的兜底清单。 */
export async function listMemoryEntryFiles(paths: ProjectMemoryPaths): Promise<string[]> {
  try {
    return (await readdir(paths.entriesDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, "zh-Hans"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

/** 项目记忆目录根下散落的旧详情文件（迁移进来的 server.md 之类），也要进索引。 */
async function listLooseMarkdown(paths: ProjectMemoryPaths): Promise<string[]> {
  try {
    return (await readdir(paths.projectMemoryDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile()
        && entry.name.toLowerCase().endsWith(".md")
        && entry.name !== basename(paths.memoryFile))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, "zh-Hans"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * 把「一个 MEMORY.md 装下全部记忆」改成「MEMORY.md 只放索引，正文分文件」。
 *
 * 用户盘上已经有旧格式的记忆，所以迁移必须自动发生且无损：正文原封不动搬进
 * memories/ 下的独立文件，MEMORY.md 换成指向它们的索引，一个字都不丢。已经是
 * 索引的文件直接跳过，所以这个函数每次会话启动都可以安全地跑。
 */
function needsIndexMigration(content: string, loose: readonly string[]): boolean {
  if (!content && !loose.length) return false;
  if (!isMemoryIndex(content)) return true;
  const indexed = new Set(parseMemoryIndex(content).map((entry) => entry.file));
  return loose.some((file) => !indexed.has(file));
}

export async function migrateProjectMemoryToIndex(paths: ProjectMemoryPaths): Promise<boolean> {
  if (!needsIndexMigration(
    (await readUtf8(paths.memoryFile)).trim(),
    await listLooseMarkdown(paths),
  )) return false;

  return withFileLock(join(paths.projectMemoryDir, ".index-migration"), async () => {
    const latest = (await readUtf8(paths.memoryFile)).trim();
    const looseFiles = await listLooseMarkdown(paths);
    if (!needsIndexMigration(latest, looseFiles)) return false;

    const alreadyIndexed = isMemoryIndex(latest);
    const entries: MemoryIndexEntry[] = alreadyIndexed ? parseMemoryIndex(latest) : [];
    const indexedCount = entries.length;
    const taken = new Set(await listMemoryEntryFiles(paths));
    if (!alreadyIndexed) {
      let fallbackIndex = 1;
      for (const section of splitLegacyMemory(latest)) {
        const fileName = memoryEntryFileName(section.title, taken, fallbackIndex);
        fallbackIndex += 1;
        taken.add(fileName);
        await mkdir(paths.entriesDir, { recursive: true, mode: 0o700 });
        await atomicWrite(join(paths.entriesDir, fileName), `${section.body}\n`);
        entries.push({
          title: section.title,
          file: memoryEntryPath(fileName),
          summary: summarizeMemoryBody(section.body),
        });
      }
    }
    // 旧的详情文件留在原地，只补索引：它们已经是「正文分文件」的形态，
    // 再搬一次只会让用户手写的相对链接失效。
    for (const fileName of looseFiles) {
      if (entries.some((entry) => entry.file === fileName)) continue;
      const body = await readUtf8(join(paths.projectMemoryDir, fileName));
      entries.push({
        title: body.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim() || basename(fileName, ".md"),
        file: fileName,
        summary: summarizeMemoryBody(body),
      });
    }
    // 已经是索引、又没有新条目要补的，原样留着：用户可能亲手编辑过索引正文，
    // 每轮重写一遍只会把他的改动洗掉。
    if (!entries.length || (alreadyIndexed && entries.length === indexedCount)) return false;
    await atomicWrite(paths.memoryFile, renderMemoryIndex(entries));
    return true;
  });
}

export async function ensureProjectMemory(paths: ProjectMemoryPaths): Promise<void> {
  await mkdir(paths.storageRoot, { recursive: true, mode: 0o700 });
  await ensureFile(paths.globalMemoryFile, "");
  await mkdir(paths.projectMemoryDir, { recursive: true, mode: 0o700 });
  await migrateLegacyProjectMemory(paths);
  await ensureFile(paths.memoryFile, MEMORY_TEMPLATE);
  await migrateProjectMemoryToIndex(paths);
}

export async function enforceProjectMemoryLimit(
  paths: ProjectMemoryPaths,
  _maximum = PROJECT_MEMORY_MAX_CHARS,
): Promise<EnforcedMemory> {
  await ensureProjectMemory(paths);
  return { content: await readUtf8(paths.memoryFile) };
}
