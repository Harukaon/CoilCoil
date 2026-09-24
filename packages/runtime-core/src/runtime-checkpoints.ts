import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { DiagnosticLog } from "@coilcoil/diagnostics";
import type { RewindPreview } from "@coilcoil/runtime-protocol";
import { CheckpointStore, checkpointsSupported } from "./checkpoint-store.js";
import { errorMessage } from "./runtime-utils.js";

/**
 * 检查点在会话里的记法：Pi 写下用户消息之后，紧跟着挂一条自定义条目
 * `{ messageEntryId, commit }`，和提示词文档（PROMPT_DOCUMENT_ENTRY_TYPE）一个做法。
 * 自定义条目不进模型的上下文，跟着会话文件走，重开 App 也还在。
 *
 * 回退时再挂一条 `{ restored, backup }`：backup 是回退前工作区的样子，退错了能找回。
 */
export const CHECKPOINT_ENTRY_TYPE = "coilcoil-checkpoint-v1";
export const CHECKPOINT_RESTORE_ENTRY_TYPE = "coilcoil-checkpoint-restore-v1";

const stores = new Map<string, CheckpointStore>();

/** 工作区的影子仓库；家目录、磁盘根目录这种不做检查点，返回 undefined。 */
export function checkpointStore(dataDir: string, cwd: string): CheckpointStore | undefined {
  if (!checkpointsSupported(cwd)) return undefined;
  const key = `${dataDir}\0${cwd}`;
  let store = stores.get(key);
  if (!store) {
    store = new CheckpointStore(cwd, dataDir);
    stores.set(key, store);
  }
  return store;
}

function checkpointData(entry: SessionEntry): { messageEntryId: string; commit: string } | undefined {
  if (entry.type !== "custom" || entry.customType !== CHECKPOINT_ENTRY_TYPE) return undefined;
  const data = entry.data as { messageEntryId?: unknown; commit?: unknown } | undefined;
  return typeof data?.messageEntryId === "string" && typeof data.commit === "string"
    ? { messageEntryId: data.messageEntryId, commit: data.commit }
    : undefined;
}

/** 一条分支上每条用户消息的检查点：消息条目 id → 快照提交。 */
export function checkpointsOnBranch(branch: readonly SessionEntry[]): Map<string, string> {
  const checkpoints = new Map<string, string>();
  for (const entry of branch) {
    const data = checkpointData(entry);
    if (data) checkpoints.set(data.messageEntryId, data.commit);
  }
  return checkpoints;
}

/**
 * 一条用户消息交给 Pi 之前存检查点。要在 Pi 开始跑之前存好，不然存进去的可能已经是
 * Agent 改过的样子。存失败只记日志：没有检查点只是不能回退代码，不该拦住消息。
 */
export async function captureCheckpoint(dataDir: string, cwd: string, log: DiagnosticLog): Promise<string | undefined> {
  const store = checkpointStore(dataDir, cwd);
  if (!store) return undefined;
  try {
    return await store.snapshot();
  } catch (error) {
    log.warn("checkpoint", "snapshot_failed", { error: errorMessage(error) });
    return undefined;
  }
}

type SessionManagerLike = AgentSession["sessionManager"];

/** Pi 写下用户消息之后调用：找到这条消息的条目，挂上检查点。 */
export function bindCheckpoint(manager: SessionManagerLike, rawMessage: unknown, commit: string): void {
  const entry = [...manager.getBranch()].reverse().find((candidate) =>
    candidate.type === "message" && candidate.message === rawMessage && candidate.message.role === "user");
  if (entry) manager.appendCustomEntry(CHECKPOINT_ENTRY_TYPE, { messageEntryId: entry.id, commit });
}

/** 编辑历史消息之前：这条消息有没有检查点，回退的话会动到哪些文件。 */
export async function previewRewind(dataDir: string, cwd: string, branch: readonly SessionEntry[], entryId: string): Promise<RewindPreview> {
  const commit = checkpointsOnBranch(branch).get(entryId);
  const store = checkpointStore(dataDir, cwd);
  if (!commit || !store) return { checkpoint: false, files: [] };
  return { checkpoint: true, files: await store.changesSince(commit) };
}

/**
 * 回到会话树上的某条消息；`restoreCode` 时先把工作区退回那条消息的检查点。
 * 会话没切过去（取消、出错）就把代码也换回来，不留一个对话和代码对不上的半截状态。
 */
export async function navigateWithCheckpoint(options: {
  dataDir: string;
  cwd: string;
  session: AgentSession;
  entryId: string;
  restoreCode: boolean;
  log: DiagnosticLog;
}): Promise<{ cancelled: boolean }> {
  const { session, entryId } = options;
  if (!options.restoreCode) return session.navigateTree(entryId, { summarize: false });
  const commit = checkpointsOnBranch(session.sessionManager.getBranch()).get(entryId);
  const store = checkpointStore(options.dataDir, options.cwd);
  if (!commit || !store) throw new Error("这条消息没有检查点，没法回退代码。");
  const { backup, files } = await store.restore(commit);
  try {
    const result = await session.navigateTree(entryId, { summarize: false });
    if (result.cancelled) {
      await store.restore(backup);
      return result;
    }
    session.sessionManager.appendCustomEntry(CHECKPOINT_RESTORE_ENTRY_TYPE, { restored: commit, backup, files: files.length });
    options.log.info("checkpoint", "restored", { files: files.length });
    return result;
  } catch (error) {
    await store.restore(backup).catch(() => undefined);
    throw error;
  }
}
