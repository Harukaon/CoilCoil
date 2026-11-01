import { createHash } from "node:crypto";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProjectMemoryPaths } from "./memory-settings.ts";
import { DEFAULT_MEMORY_IDLE_DELAY_MS } from "./memory-settings.ts";
import { atomicWrite, canonicalPath, readUtf8, resolveProjectMemoryPaths, resolveProjectMemoryStorageRoot } from "./memory-storage.ts";
import { canonicalCandidate } from "./memory-worker-guard.ts";

export interface MemoryInput { path: string; revision: string; kind: "session" | "note"; bytes: number }
export interface MemoryInputBatch { inputs: MemoryInput[]; sessionFiles: string[]; noteFiles: string[] }
const INPUT_STATE = ".dream-inputs.json";
const MAX_SESSION_INPUTS = 12;
const MAX_NOTE_INPUTS = 50;
const inside = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child === "" || child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

async function processedInputs(paths: ProjectMemoryPaths): Promise<Record<string, string>> {
  const raw = await readUtf8(join(paths.projectMemoryDir, INPUT_STATE));
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("记忆整理输入状态无效");
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export async function pendingMemoryNotes(paths: ProjectMemoryPaths): Promise<MemoryInput[]> {
  const processed = await processedInputs(paths);
  const result: MemoryInput[] = [];
  let names;
  try { names = await readdir(paths.notesDir, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  for (const item of names.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!item.isFile() || !item.name.endsWith(".md")) continue;
    const path = join(paths.notesDir, item.name);
    const content = await readFile(path);
    const revision = createHash("sha256").update(content).digest("hex");
    if (processed[path] !== revision) result.push({ path, revision, kind: "note", bytes: content.byteLength });
  }
  return result;
}

async function belongsToWorkspace(path: string, projectRoot: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(16_384);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0];
    let header;
    try { header = JSON.parse(line); } catch { return false; }
    return header.type === "session" && typeof header.cwd === "string"
      && await canonicalPath(header.cwd) === projectRoot;
  } finally { await handle.close(); }
}

/** Batch only this workspace's conversations, never neighboring workspaces or worker runs. */
export async function collectMemoryInputs(paths: ProjectMemoryPaths, currentSession?: string, sessionDirectory?: string): Promise<MemoryInputBatch> {
  const processed = await processedInputs(paths);
  const files = new Set<string>();
  if (currentSession) {
    try { if ((await stat(currentSession)).isFile() && await belongsToWorkspace(currentSession, paths.projectRoot)) files.add(currentSession); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const requestedDirectory = sessionDirectory ?? (currentSession ? dirname(currentSession) : undefined);
  const directory = requestedDirectory ? await canonicalPath(requestedDirectory) : undefined;
  let siblings: import("node:fs").Dirent[] = [];
  if (directory) {
    try { siblings = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const item of siblings) {
    if (item.isFile() && item.name.endsWith(".jsonl")) {
      const path = join(directory!, item.name);
      if (path !== currentSession && await belongsToWorkspace(path, paths.projectRoot)) files.add(path);
    }
  }
  const sessions: MemoryInput[] = [];
  for (const path of files) {
    const info = await stat(path);
    const revision = `${info.size}:${info.mtimeMs}`;
    if (processed[path] !== revision) sessions.push({ path, revision, kind: "session", bytes: info.size });
  }
  const notes = (await pendingMemoryNotes(paths)).slice(0, MAX_NOTE_INPUTS);
  const selected = sessions.slice(0, MAX_SESSION_INPUTS);
  return { inputs: [...selected, ...notes], sessionFiles: selected.map((item) => item.path), noteFiles: notes.map((item) => item.path) };
}

/** Called under the workspace worker lease; only the captured revisions are acknowledged. */
export async function completeMemoryInputs(paths: ProjectMemoryPaths, batch: MemoryInputBatch): Promise<void> {
  const processed = await processedInputs(paths);
  for (const input of batch.inputs) processed[input.path] = input.revision;
  await atomicWrite(join(paths.projectMemoryDir, INPUT_STATE), JSON.stringify(processed, null, 2) + "\n");
}

/** The normal agent writes candidates; the isolated curator owns durable memory. */
export function installMemoryWritePolicy(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env, trackActivity = false): void {
  if (env.PI_MEMORY_WORKER === "1") return;
  const storageRoot = resolveProjectMemoryStorageRoot(env);
  if (trackActivity) {
    let activity: ReturnType<typeof memoryIdleCoordinator> | undefined;
    pi.on("before_agent_start", async (_event, ctx) => {
      const paths = await resolveProjectMemoryPaths(ctx.cwd, storageRoot);
      activity ??= memoryIdleCoordinator(paths.projectMemoryDir);
      activity.start();
    });
    pi.on("agent_settled", () => activity?.close());
    pi.on("session_shutdown", () => activity?.close());
  }
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const raw = (event.input as Record<string, unknown>).path;
    if (typeof raw !== "string" || !raw.trim()) return;
    const target = await canonicalCandidate(raw, ctx.cwd);
    const root = await canonicalCandidate(storageRoot, ctx.cwd);
    const requested = resolve(ctx.cwd, raw);
    if (!inside(root, target) && !inside(resolve(storageRoot), requested)) return;
    const paths = await resolveProjectMemoryPaths(ctx.cwd, storageRoot);
    const notes = await canonicalCandidate(paths.notesDir, ctx.cwd);
    if (inside(root, notes) && inside(notes, target) && target.endsWith(".md") && dirname(target) === notes) return;
    return { block: true, reason: `长期记忆由后台 Workspace 整理 Agent 维护。请把记忆候选写为随手记：${paths.notesDir}/主题.md；不要直接修改 MEMORY.md、长期正文或全局记忆，也不要通过 shell 或其他工具绕过。` };
  });
}

type IdleCallback = (canStart: () => boolean) => Promise<void>;
interface IdleWorkspace { busy: Set<symbol>; generation: number; timer?: NodeJS.Timeout; run?: { owner: symbol; callback: IdleCallback } }
const idleWorkspaces = new Map<string, IdleWorkspace>();

/** One debounce timer per workspace; a turn in any sibling conversation delays the dream. */
export function memoryIdleCoordinator(key: string, delayMs = DEFAULT_MEMORY_IDLE_DELAY_MS) {
  const owner = Symbol(key);
  let state = idleWorkspaces.get(key);
  if (!state) { state = { busy: new Set(), generation: 0 }; idleWorkspaces.set(key, state); }
  const permission = () => {
    const generation = state.generation;
    return () => state.busy.size === 0 && state.generation === generation;
  };
  const cancelTimer = () => { if (state.timer) clearTimeout(state.timer); state.timer = undefined; };
  const schedule = (immediate = false) => {
    cancelTimer();
    if (state.busy.size || !state.run) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      const run = state.run;
      state.run = undefined;
      if (run) void run.callback(permission()).catch((error) => console.error("[project-memory] 后台整理调度失败：", error));
    }, immediate ? 0 : delayMs);
    state.timer.unref?.();
  };
  return {
    start() { state.generation++; state.busy.add(owner); cancelTimer(); },
    async settled(run: IdleCallback, immediate = false) {
      state.busy.delete(owner); state.run = { owner, callback: run };
      if (immediate && !state.busy.size) { cancelTimer(); state.run = undefined; await run(permission()); }
      else schedule();
    },
    enqueue(run: IdleCallback) { state.run ??= { owner, callback: run }; schedule(); },
    cancel() {
      state.busy.delete(owner);
      if (state.run?.owner === owner) { state.run = undefined; cancelTimer(); }
      else schedule();
    },
    close() { state.busy.delete(owner); schedule(); },
  };
}
