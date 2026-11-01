import { collectMemoryInputs, completeMemoryInputs, installMemoryWritePolicy, memoryIdleCoordinator, pendingMemoryNotes } from "./memory-jottings.ts";
import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { RUNTIME_BRIDGE_STATE_EVENT, type RuntimeBridgeState } from "./runtime-bridge.ts";
import { MEMORY_STATUS_PUBLISHER_REQUEST, type MemoryStatusPublisherRequest } from "./memory-status-channel.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  MEMORY_PROMPT_MARKER,
  PROJECT_MEMORY_MAX_CHARS,
  buildGlobalMemoryPrompt,
  buildProjectMemoryPrompt,
  buildMemorySizeNotice,
  countCharacters,
  readMemorySettings,
  type ProjectMemoryPaths,
} from "./memory-settings.ts";
import {
  launchMemoryWorker,
  type MemoryWorkerOptions,
} from "./memory-worker.ts";
import {
  canonicalPath,
  enforceProjectMemoryLimit,
  isInsidePiDirectory,
  listMemoryEntryFiles,
  pathExists,
  readPersistedMemoryState,
  readUtf8,
  recordMemoryTurn,
  resetMemoryTurns,
  resolveProjectMemoryPaths,
  resolveProjectMemoryStorageRoot,
  ensureProjectMemory,
  recordProcessedSession,
} from "./memory-storage.ts";

export {
  DEFAULT_MEMORY_GENERATION_RULES,
  DEFAULT_MEMORY_SUMMARIZE_EVERY_TURNS,
  GLOBAL_MEMORY_MAX_CHARS,
  MEMORY_PROMPT_MARKER,
  PROJECT_MEMORY_MAX_CHARS,
  buildGlobalMemoryPrompt,
  buildMemorySizeNotice,
  buildMemoryWorkerPrompt,
  buildProjectMemoryPrompt,
  countCharacters,
  normalizeSummarizeEveryTurns,
  readMemorySettings,
  resolveMemorySettingsPath,
} from "./memory-settings.ts";
export {
  MEMORY_ENTRIES_DIRNAME,
  MEMORY_ENTRIES_HEADING,
  MEMORY_FACTS_HEADING,
  MEMORY_FACTS_MAX,
  MEMORY_INDEX_MARKER,
  isMemoryIndex,
  parseMemoryFacts,
  parseMemoryIndex,
  renderMemoryIndex,
  splitLegacyMemory,
} from "./memory-index.ts";
export type { MemoryIndexEntry } from "./memory-index.ts";
export { buildMemoryWorkerLaunch, resolvePiWorkerInvocation } from "./memory-worker.ts";
export type { MemoryWorkerChild, MemoryWorkerLaunch, MemoryWorkerOptions, MemoryWorkerRequest } from "./memory-worker.ts";
export type { MemorySettings, ProjectMemoryPaths } from "./memory-settings.ts";
export {
  canonicalPath,
  enforceProjectMemoryLimit,
  ensureProjectMemory,
  isInsidePiDirectory,
  listMemoryEntryFiles,
  migrateProjectMemoryToIndex,
  pathExists,
  readPersistedMemoryState,
  readUtf8,
  recordMemoryTurn,
  recordProcessedSession,
  resetMemoryTurns,
  resolveProjectMemoryPaths,
  resolveProjectMemoryStorageRoot,
  resolveProjectRoot,
} from "./memory-storage.ts";
export type { PersistedProjectMemoryState } from "./memory-storage.ts";
export const PROJECT_MEMORY_STATUS_EVENT = "coilcoil:project-memory:status:v1";

export type ProjectMemoryRunState = "idle" | "running" | "busy" | "succeeded" | "failed" | "disabled";

export interface ProjectMemoryStatusEvent {
  version: 1;
  cwd: string;
  updatedAt: number;
  attemptId?: string;
  projectRoot?: string;
  projectName?: string;
  memoryFile?: string;
  projectMemoryDir?: string;
  notesDir?: string;
  legacyMemoryDir?: string;
  migrationNotice?: string;
  pendingNotes?: number;
  state: ProjectMemoryRunState;
  source: "startup" | "prompt" | "manual" | "automatic";
  exists: boolean;
  injected: boolean;
  contentChars?: number;
  estimatedTokens?: number;
  sessionFile?: string;
  processedSessions: string[];
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  message?: string;
  error?: string;
}

export interface EnforcedMemory {
  content: string;
}

export interface ProjectMemoryExtensionOptions extends MemoryWorkerOptions {
  /** Test/host override; the product default is five quiet minutes. */
  idleDelayMs?: number;
}


async function prepareMemory(
  cwd: string,
  storageRoot = resolveProjectMemoryStorageRoot(),
  maximum = PROJECT_MEMORY_MAX_CHARS,
): Promise<{ paths: ProjectMemoryPaths; memory: EnforcedMemory }> {
  const paths = await resolveProjectMemoryPaths(cwd, storageRoot);
  await ensureProjectMemory(paths);
  const memory = await enforceProjectMemoryLimit(paths, maximum);
  return { paths, memory };
}

function notifyOnce(
  state: { warned: boolean },
  notify: ((message: string, type?: "info" | "warning" | "error") => void) | undefined,
  error: unknown,
  label: string,
): void {
  if (state.warned || !notify) return;
  state.warned = true;
  const message = error instanceof Error ? error.message : String(error);
  notify(`${label}：${message}`, "warning");
}

function snapshotNotifier(
  ctx: ExtensionContext,
): ((message: string, type?: "info" | "warning" | "error") => void) | undefined {
  if (!ctx.hasUI) return undefined;
  const ui = ctx.ui;
  return (message, type) => ui.notify(message, type);
}

async function memoryIsDisabled(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (env.PI_MEMORY_WORKER === "1") return true;
  return isInsidePiDirectory(cwd);
}

export default function projectMemoryExtension(
  pi: ExtensionAPI,
  options: ProjectMemoryExtensionOptions = {},
): void {
  const env = options.env ?? process.env;
  const warningState = { warned: false };
  const backgroundWarningState = { warned: false };
  const storageRoot = resolveProjectMemoryStorageRoot(env);
  installMemoryWritePolicy(pi, env);
  let idle: ReturnType<typeof memoryIdleCoordinator> | undefined;
  let active = true;
  let sessionPromptLocked = false;
  let status: ProjectMemoryStatusEvent | undefined;
  let publishRuntimeStatus: MemoryStatusPublisherRequest["publish"];

  const publishStatus = (
    cwd: string,
    update: Partial<ProjectMemoryStatusEvent> & Pick<ProjectMemoryStatusEvent, "state" | "source">,
  ): ProjectMemoryStatusEvent => {
    const updatedAt = Math.max(Date.now(), (status?.updatedAt ?? 0) + 1);
    const next = {
      version: 1,
      cwd,
      updatedAt,
      exists: status?.exists ?? false,
      injected: status?.injected ?? false,
      processedSessions: status?.processedSessions ?? [],
      ...status,
      ...update,
    };
    status = { ...next, version: 1, cwd, updatedAt };
    if (!publishRuntimeStatus && active) {
      const request: MemoryStatusPublisherRequest = {};
      pi.events.emit(MEMORY_STATUS_PUBLISHER_REQUEST, request);
      publishRuntimeStatus = request.publish;
    }
    if (publishRuntimeStatus) publishRuntimeStatus(status);
    else if (active) pi.events.emit(PROJECT_MEMORY_STATUS_EVENT, status);
    return status;
  };

  const unsubscribePrompt = pi.events.on(RUNTIME_BRIDGE_STATE_EVENT, (raw) => {
    const state = raw as RuntimeBridgeState | undefined;
    if (!state || typeof state.promptLocked !== "boolean" || state.promptLocked === sessionPromptLocked) return;
    sessionPromptLocked = state.promptLocked;
    if (!status || !sessionPromptLocked) return;
    publishStatus(status.cwd, { state: status.state, source: "prompt",
      injected: Boolean(state.effectiveSystemPrompt?.includes(MEMORY_PROMPT_MARKER)),
      message: "当前会话使用固定的记忆快照，记忆更新将在新对话生效" });
  });

  const memoryMetadata = async (paths: ProjectMemoryPaths): Promise<Pick<ProjectMemoryStatusEvent,
    "projectRoot" | "projectName" | "memoryFile" | "projectMemoryDir" | "notesDir" | "legacyMemoryDir" | "migrationNotice" | "pendingNotes" | "exists" | "contentChars" | "estimatedTokens" | "processedSessions"
  >> => {
    const content = await readUtf8(paths.memoryFile);
    const contentChars = countCharacters(content);
    const persisted = await readPersistedMemoryState(paths);
    return {
      projectRoot: paths.projectRoot,
      projectName: paths.projectName,
      memoryFile: paths.memoryFile,
      projectMemoryDir: paths.projectMemoryDir,
      notesDir: paths.notesDir,
      legacyMemoryDir: paths.legacyMemoryDir,
      migrationNotice: paths.migrationNotice,
      pendingNotes: (await pendingMemoryNotes(paths)).length,
      exists: await pathExists(paths.memoryFile),
      contentChars,
      estimatedTokens: Math.ceil(contentChars / 4),
      processedSessions: persisted.processedSessions,
    };
  };

  const summarizeSession = async (
    ctx: ExtensionContext,
    notifyStarted: boolean,
    source: ProjectMemoryStatusEvent["source"] = notifyStarted ? "manual" : "automatic",
    canStart?: () => boolean,
  ): Promise<"started" | "busy" | "skipped" | "failed"> => {
    // Pi deliberately invalidates ExtensionContext after reload/session replacement.
    // A memory worker can outlive that context, so capture every value needed by its
    // completion callbacks before the first await and never retain `ctx` there.
    const cwd = ctx.cwd;
    const currentModel = ctx.model;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionDirectory = ctx.sessionManager.getSessionDir?.();
    const capturedNotify = snapshotNotifier(ctx);
    const settings = await readMemorySettings(env);
    const model = settings.workerProvider && settings.workerModelId
      ? { provider: settings.workerProvider, id: settings.workerModelId }
      : currentModel ? { provider: currentModel.provider, id: currentModel.id } : undefined;
    const notify = (message: string, type?: "info" | "warning" | "error"): void => {
      if (active) capturedNotify?.(message, type);
    };
    const attemptId = randomUUID();
    if (await memoryIsDisabled(cwd, env)) {
      publishStatus(cwd, { state: "disabled", source, attemptId, exists: false, injected: false, message: "当前目录已禁用项目记忆" });
      if (notifyStarted) notify?.("当前目录位于 .pi 内，已禁用记忆整理以防递归", "warning");
      return "skipped";
    }
    if (Boolean(settings.workerProvider) !== Boolean(settings.workerModelId)) {
      publishStatus(cwd, { state: "failed", source, attemptId, error: "后台整理模型配置不完整，请同时选择供应商和模型" });
      return "failed";
    }
    if (!model) {
      publishStatus(cwd, { state: "failed", source, attemptId, error: "当前没有可用于记忆整理的模型" });
      if (notifyStarted) notify?.("当前没有可用于记忆整理的模型", "warning");
      return "skipped";
    }

    try {
      if (source === "automatic" && (!settings.autoSummarize || !settings.projectEnabled)) return "skipped";
      const { paths } = await prepareMemory(cwd, storageRoot, settings.projectMaxChars);
      const canonicalSessionFile = sessionFile && await pathExists(sessionFile) ? await canonicalPath(sessionFile) : undefined;
      const inputs = await collectMemoryInputs(paths, canonicalSessionFile, sessionDirectory);
      if (source === "automatic" && inputs.inputs.length === 0) return "skipped";
      const persisted = await readPersistedMemoryState(paths);
      const processedSessions = [...new Set([...(status?.processedSessions ?? []), ...persisted.processedSessions])];
      const startedAt = Date.now();
      const nextContext = { cwd, model: currentModel, hasUI: Boolean(capturedNotify), ui: { notify: capturedNotify },
        sessionManager: { getSessionFile: () => sessionFile, getSessionDir: () => sessionDirectory } } as ExtensionContext;
      const workspaceIdle = memoryIdleCoordinator(paths.projectMemoryDir, options.idleDelayMs);
      const result = await launchMemoryWorker({
        paths,
        sessionFile: canonicalSessionFile,
        inputs,
        provider: model.provider,
        model: model.id,
        maximum: settings.projectMaxChars,
        generationRules: settings.generationRules,
      }, options, {
        canStart: source === "automatic" ? canStart : undefined,
        onStarted: () => {
          publishStatus(cwd, {
            state: "running",
            source,
            attemptId,
            ...paths,
            exists: true,
            sessionFile: canonicalSessionFile,
            processedSessions,
            startedAt,
            completedAt: undefined,
            durationMs: undefined,
            error: undefined,
            message: "后台 Agent 正在筛选随手记与 Workspace 对话…",
          });
        },
        onComplete: async () => {
          try {
            await completeMemoryInputs(paths, inputs);
            let completedSessions: string[] = [];
            for (const file of inputs.sessionFiles) completedSessions = await recordProcessedSession(paths, file);
            const metadata = await memoryMetadata(paths);
            const completedAt = Date.now();
            const latestSettings = await readMemorySettings(env);
            if (latestSettings.autoSummarize && latestSettings.projectEnabled && inputs.inputs.length
              && (await collectMemoryInputs(paths, canonicalSessionFile, sessionDirectory)).inputs.length) {
              workspaceIdle.enqueue(async (allowed) => { await summarizeSession(nextContext, false, "automatic", allowed); });
            }
            publishStatus(cwd, {
              state: "succeeded",
              source,
              attemptId,
              ...metadata,
              sessionFile: canonicalSessionFile,
              processedSessions: [...new Set([...completedSessions, ...metadata.processedSessions])],
              startedAt,
              completedAt,
              durationMs: completedAt - startedAt,
              error: undefined,
              message: "随手记筛选与长期记忆整理完成",
            });
          } catch (error) {
            publishStatus(cwd, {
              state: "failed",
              source,
              attemptId,
              sessionFile: canonicalSessionFile,
              processedSessions,
              startedAt,
              completedAt: Date.now(),
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        onError: (error) => {
          notifyOnce(backgroundWarningState, notify, error, "后台记忆整理失败");
          const completedAt = Date.now();
          publishStatus(cwd, {
            state: "failed",
            source,
            attemptId,
            sessionFile: canonicalSessionFile,
            processedSessions,
            startedAt,
            completedAt,
            durationMs: completedAt - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });
      if (result === "deferred") {
        workspaceIdle.enqueue(async (allowed) => { await summarizeSession(nextContext, false, "automatic", allowed); });
        return "skipped";
      }
      // 跑过一次就从头开始数：手动整理同样重置倒计时，否则用户点完「立即整理」
      // 还会在几轮后被自动整理再跑一遍。
      if (result === "started") await resetMemoryTurns(paths);
      if (notifyStarted && result === "started") notify?.("记忆整理已在后台启动", "info");
      if (result === "busy") {
        publishStatus(cwd, {
          state: "busy",
          source,
          attemptId,
          ...await memoryMetadata(paths),
          sessionFile: canonicalSessionFile,
          message: "当前项目已有记忆整理正在运行",
        });
        if (notifyStarted) notify?.("当前项目已有记忆整理正在运行", "info");
      }
      return result;
    } catch (error) {
      notifyOnce(backgroundWarningState, notify, error, "后台记忆整理失败");
      publishStatus(cwd, { state: "failed", source, attemptId, error: error instanceof Error ? error.message : String(error) });
      return "failed";
    }
  };

  pi.registerCommand("memory", {
    description: "立即在后台整理当前项目记忆",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("用法：/memory", "warning");
        return;
      }
      await summarizeSession(ctx, true, "manual");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionPromptLocked = false;
    const cwd = ctx.cwd;
    const notify = snapshotNotifier(ctx);
    const currentModel = ctx.model;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionDirectory = ctx.sessionManager.getSessionDir?.();
    const captured = { cwd, model: currentModel, hasUI: Boolean(notify), ui: { notify },
      sessionManager: { getSessionFile: () => sessionFile, getSessionDir: () => sessionDirectory } } as ExtensionContext;
    if (await memoryIsDisabled(cwd, env)) {
      publishStatus(cwd, { state: "disabled", source: "startup", exists: false, injected: false });
      return;
    }
    try {
      const settings = await readMemorySettings(env);
      const { paths } = await prepareMemory(cwd, storageRoot, settings.projectMaxChars);
      idle = memoryIdleCoordinator(paths.projectMemoryDir, options.idleDelayMs);
      if (settings.autoSummarize && settings.projectEnabled) {
        idle.enqueue(async (allowed) => { await summarizeSession(captured, false, "automatic", allowed); });
      }
      publishStatus(cwd, {
        state: "idle",
        source: "startup",
        ...await memoryMetadata(paths),
        injected: false,
        message: "项目记忆已就绪",
      });
    } catch (error) {
      notifyOnce(warningState, notify, error, "项目记忆初始化失败");
    }
  });

  pi.on("session_tree", () => { sessionPromptLocked = false; });
  pi.on("session_shutdown", () => { active = false; unsubscribePrompt(); idle?.close(); });

  pi.on("before_agent_start", async (event, ctx) => {
    idle?.start();
    // The bridge owns the final prompt snapshot. Later turns need no disk reads
    // or extra memory messages, even if settings or background memory changed.
    if (sessionPromptLocked) return undefined;
    const cwd = ctx.cwd;
    const notify = snapshotNotifier(ctx);
    if (await memoryIsDisabled(cwd, env)) return undefined;
    if (event.systemPrompt.includes(MEMORY_PROMPT_MARKER)) return undefined;
    try {
      const settings = await readMemorySettings(env);
      const { paths, memory } = await prepareMemory(cwd, storageRoot, settings.projectMaxChars);
      const globalContent = settings.globalEnabled ? await readUtf8(paths.globalMemoryFile) : "";
      const entryFiles = settings.projectEnabled ? await listMemoryEntryFiles(paths) : [];
      const injected = [
        settings.globalEnabled ? buildGlobalMemoryPrompt(paths, globalContent, settings.globalMaxChars) : "",
        settings.projectEnabled ? buildProjectMemoryPrompt(paths, memory.content, settings.projectMaxChars, settings.generationRules, entryFiles) : "",
      ].filter(Boolean).join("\n\n");
      publishStatus(cwd, {
        state: status?.state === "running" ? "running" : "idle",
        source: "prompt",
        ...await memoryMetadata(paths),
        injected: true,
        message: "项目记忆已注入当前会话",
      });
      return {
        systemPrompt: [event.systemPrompt, injected].filter(Boolean).join("\n\n"),
      };
    } catch (error) {
      notifyOnce(warningState, notify, error, "项目记忆注入失败");
      return undefined;
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || !["write", "edit"].includes(event.toolName)) return;
    const rawPath = (event.input as Record<string, unknown>).path;
    if (typeof rawPath !== "string") return;
    const paths = await resolveProjectMemoryPaths(ctx.cwd, storageRoot);
    if (resolvePath(ctx.cwd, rawPath).startsWith(paths.notesDir + "/")) {
      publishStatus(ctx.cwd, { state: status?.state ?? "idle", source: "prompt", ...await memoryMetadata(paths),
        message: "随手记已保存，等待后台筛选；尚未进入长期记忆" });
    }
  });

  // One workspace coordinator waits until every conversation is idle. The captured
  // values remain usable after a tab closes; no retired ExtensionContext is held.
  pi.on("agent_settled", async (event, ctx) => {
    const cwd = ctx.cwd;
    const currentModel = ctx.model;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionDirectory = ctx.sessionManager.getSessionDir?.();
    const notify = snapshotNotifier(ctx);
    const captured = { cwd, model: currentModel, hasUI: Boolean(notify), ui: { notify },
      sessionManager: { getSessionFile: () => sessionFile, getSessionDir: () => sessionDirectory } } as ExtensionContext;
    const settings = await readMemorySettings(env);
    if (!settings.autoSummarize || !settings.projectEnabled || await memoryIsDisabled(cwd, env)) { idle?.cancel(); return; }
    try {
      const paths = await resolveProjectMemoryPaths(cwd, storageRoot);
      idle ??= memoryIdleCoordinator(paths.projectMemoryDir, options.idleDelayMs);
      const turns = event.aborted ? (await readPersistedMemoryState(paths)).turnsSinceSummary : await recordMemoryTurn(paths);
      await idle.settled(async (allowed) => { await summarizeSession(captured, false, "automatic", allowed); }, turns >= settings.summarizeEveryTurns);
    } catch (error) {
      notifyOnce(backgroundWarningState, notify, error, "记忆整理调度失败");
    }
  });
}
