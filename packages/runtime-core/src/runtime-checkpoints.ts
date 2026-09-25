import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentSession, InlineExtension, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { DiagnosticLog } from "@coilcoil/diagnostics";
import type { GitCommitFile, RewindPreview } from "@coilcoil/runtime-protocol";
import { blobHash, FileHistoryStore, MAX_BACKUP_BYTES } from "./file-history-store.js";
import { errorMessage } from "./runtime-utils.js";

/**
 * 检查点：编辑一条历史消息时，把 Agent 在那之后改过的文件恢复到那条消息发出时的样子。
 *
 * 做法和 Claude Code 一样：不给整个工作区拍快照，而是 Agent 每次用 edit / write 改
 * 一个文件之前，先把这个文件原来的内容备份（同一条用户消息里同一个文件只备份第一次）。
 * 回退时只动这些被 Agent 改过的文件，同一个文件夹下其它项目、用户自己改的文件一概
 * 不碰；工作区多大、是不是 git 仓库都无所谓。内容存在 git 对象库里（file-history-store.ts）。
 *
 * 管不到的：Agent 用命令行（bash）改的文件、子代理改的文件——和 Claude Code 一样。
 *
 * 备份记在会话里：每备份一个文件挂一条自定义条目 `{ messageEntryId, path, blob | absent
 * | skipped }`，不进模型上下文，跟着会话文件走、跟着分支走。回退时再挂一条
 * `{ restored, files }`，记下回退前这些文件的样子，退错了还找得回来。
 */
export const FILE_BACKUP_ENTRY_TYPE = "coilcoil-file-backup-v1";
export const FILE_RESTORE_ENTRY_TYPE = "coilcoil-file-restore-v1";

interface FileBackup {
  messageEntryId: string;
  /** 绝对路径：Agent 可以改工作区外面的文件。 */
  path: string;
  /** 改之前的内容；absent 表示改之前这个文件不存在（回退就是删掉它）。 */
  blob?: string;
  absent?: true;
  /** 没备份下来（太大、读不了）：回退时不动它，界面上说一声。 */
  skipped?: "too_large" | "unreadable";
}

const stores = new Map<string, FileHistoryStore>();

export function fileHistoryStore(agentDir: string): FileHistoryStore {
  let store = stores.get(agentDir);
  if (!store) {
    store = new FileHistoryStore(agentDir);
    stores.set(agentDir, store);
  }
  return store;
}

function backupData(entry: SessionEntry): FileBackup | undefined {
  if (entry.type !== "custom" || entry.customType !== FILE_BACKUP_ENTRY_TYPE) return undefined;
  const data = entry.data as Partial<FileBackup> | undefined;
  return typeof data?.messageEntryId === "string" && typeof data.path === "string" ? data as FileBackup : undefined;
}

function isUserMessage(entry: SessionEntry): boolean {
  return entry.type === "message" && entry.message.role === "user";
}

/** 分支上哪些用户消息之后 Agent 改过文件——只有这些消息编辑时才可能要回退代码。 */
export function messagesWithFileChanges(branch: readonly SessionEntry[]): Set<string> {
  const result = new Set<string>();
  let changedLater = false;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (backupData(entry)) changedLater = true;
    else if (changedLater && isUserMessage(entry)) result.add(entry.id);
  }
  return result;
}

/** 和 Pi 的 edit / write 一样解析路径：去掉开头的 @、展开 ~、相对工作区。 */
function toolPath(input: Record<string, unknown>, cwd: string): string | undefined {
  const value = input.path ?? input.file_path;
  if (typeof value !== "string" || !value.trim()) return undefined;
  let path = value.trim().replace(/^@/, "");
  if (path === "~" || path.startsWith("~/")) path = homedir() + path.slice(1);
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

type Snapshot = { content: Buffer } | { absent: true } | { skipped: FileBackup["skipped"] };

function readSnapshot(path: string): Snapshot {
  try {
    if (!existsSync(path)) return { absent: true };
    const stat = statSync(path);
    if (!stat.isFile()) return { skipped: "unreadable" };
    if (stat.size > MAX_BACKUP_BYTES) return { skipped: "too_large" };
    return { content: readFileSync(path) };
  } catch {
    return { skipped: "unreadable" };
  }
}

/**
 * 装进每个会话的 Pi 扩展：edit / write 执行前备份目标文件。
 *
 * 内容在处理函数里同步读，Pi 等处理函数返回才执行工具，所以读到的一定是改之前的。
 * 「这条消息里备份过没有」看会话分支本身（重开 App、介入消息都不会乱），外加一个
 * 内存里的集合，挡住同一轮里并行的两次编辑。
 */
export function fileHistoryExtension(agentDir: string, log: DiagnosticLog): InlineExtension {
  return { name: "coilcoil-file-history", hidden: true, factory: (pi) => {
    const claimed = new Set<string>();
    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "edit" && event.toolName !== "write") return;
      const path = toolPath(event.input as Record<string, unknown>, ctx.cwd);
      if (!path) return;
      const branch = ctx.sessionManager.getBranch();
      let messageEntryId: string | undefined;
      for (let index = branch.length - 1; index >= 0 && !messageEntryId; index -= 1) {
        const entry = branch[index];
        if (isUserMessage(entry)) messageEntryId = entry.id;
        else if (backupData(entry)?.path === path) return;
      }
      if (!messageEntryId) return;
      const key = `${messageEntryId}\0${path}`;
      if (claimed.has(key)) return;
      claimed.add(key);
      const snapshot = readSnapshot(path);
      const backup: FileBackup = { messageEntryId, path };
      if ("absent" in snapshot) backup.absent = true;
      else if ("skipped" in snapshot) backup.skipped = snapshot.skipped;
      else {
        try {
          backup.blob = await fileHistoryStore(agentDir).save(snapshot.content);
        } catch (error) {
          log.warn("checkpoint", "backup_failed", { error: errorMessage(error) });
          backup.skipped = "unreadable";
        }
      }
      pi.appendEntry(FILE_BACKUP_ENTRY_TYPE, backup);
    });
  } };
}

interface PlannedChange {
  path: string;
  state: "modified" | "added" | "deleted";
  /** 要写回的内容；undefined 是删掉。 */
  blob?: string;
}

/**
 * 回到某条用户消息，要把哪些文件恢复成什么样：分支上这条消息之后，每个文件最早的
 * 那份备份就是它在这条消息发出时的样子。和现在一样的不用动；备份没存下来、或者已经
 * 过期被清掉的，放进 skipped。
 */
function planRestore(store: FileHistoryStore, branch: readonly SessionEntry[], entryId: string): { changes: PlannedChange[]; skipped: string[] } | undefined {
  const start = branch.findIndex((entry) => entry.id === entryId);
  if (start < 0) return undefined;
  const earliest = new Map<string, FileBackup>();
  for (const entry of branch.slice(start)) {
    const backup = backupData(entry);
    if (backup && !earliest.has(backup.path)) earliest.set(backup.path, backup);
  }
  const changes: PlannedChange[] = [];
  const skipped: string[] = [];
  for (const backup of earliest.values()) {
    const current = readSnapshot(backup.path);
    if (backup.absent) {
      if (!("absent" in current)) changes.push({ path: backup.path, state: "added" });
      continue;
    }
    if (!backup.blob || !store.has(backup.blob)) {
      skipped.push(backup.path);
      continue;
    }
    if ("absent" in current) changes.push({ path: backup.path, state: "deleted", blob: backup.blob });
    else if (!("content" in current) || blobHash(current.content) !== backup.blob) changes.push({ path: backup.path, state: "modified", blob: backup.blob });
  }
  return { changes, skipped };
}

function displayPath(cwd: string, path: string): string {
  const inside = relative(cwd, path);
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside.split("\\").join("/") : path;
}

/** 编辑历史消息之前：回退代码的话会动到哪些文件。 */
export function previewRewind(agentDir: string, cwd: string, branch: readonly SessionEntry[], entryId: string): RewindPreview {
  const plan = planRestore(fileHistoryStore(agentDir), branch, entryId);
  if (!plan) return { checkpoint: false, files: [] };
  return {
    checkpoint: true,
    files: plan.changes.map((change): GitCommitFile => ({ path: displayPath(cwd, change.path), state: change.state })),
    skipped: plan.skipped.map((path) => displayPath(cwd, path)),
  };
}

type Restorable = { path: string; blob?: string };

/** 按计划写回（或删掉）文件；返回写之前它们的样子，撤销用。 */
async function applyRestore(store: FileHistoryStore, targets: Restorable[]): Promise<Restorable[]> {
  // 先把要写的内容都读出来，读不全就一个文件也不动。
  const contents = new Map<string, Buffer>();
  for (const target of targets) {
    if (!target.blob) continue;
    const content = await store.read(target.blob);
    if (!content) throw new Error(`${target.path} 的备份已经不在了，没有回退任何文件。`);
    contents.set(target.path, content);
  }
  const previous: Restorable[] = [];
  for (const target of targets) {
    const current = readSnapshot(target.path);
    if ("content" in current) previous.push({ path: target.path, blob: await store.save(current.content) });
    else if ("absent" in current) previous.push({ path: target.path });
  }
  for (const target of targets) {
    const content = contents.get(target.path);
    if (content) {
      mkdirSync(dirname(target.path), { recursive: true });
      writeFileSync(target.path, content);
    } else {
      rmSync(target.path, { force: true });
    }
  }
  return previous;
}

/**
 * 回到会话树上的某条消息；`restoreCode` 时先把 Agent 在那之后改过的文件恢复原样。
 * 会话没切过去（取消、出错）就把文件也换回来，不留一个对话和代码对不上的半截状态。
 */
export async function navigateWithCheckpoint(options: {
  agentDir: string;
  session: AgentSession;
  entryId: string;
  restoreCode: boolean;
  log: DiagnosticLog;
}): Promise<{ cancelled: boolean }> {
  const { session, entryId } = options;
  if (!options.restoreCode) return session.navigateTree(entryId, { summarize: false });
  const store = fileHistoryStore(options.agentDir);
  const plan = planRestore(store, session.sessionManager.getBranch(), entryId);
  if (!plan) throw new Error("找不到这条消息，没法回退代码。");
  const previous = await applyRestore(store, plan.changes);
  const undo = (): Promise<unknown> => applyRestore(store, previous).catch(() => undefined);
  try {
    const result = await session.navigateTree(entryId, { summarize: false });
    if (result.cancelled) {
      await undo();
      return result;
    }
    session.sessionManager.appendCustomEntry(FILE_RESTORE_ENTRY_TYPE, { restored: entryId, files: previous });
    options.log.info("checkpoint", "restored", { files: plan.changes.length, skipped: plan.skipped.length });
    return result;
  } catch (error) {
    await undo();
    throw error;
  }
}
