import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
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

export type ProjectMemoryExtensionOptions = MemoryWorkerOptions;


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
  let status: ProjectMemoryStatusEvent | undefined;

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
    pi.events.emit(PROJECT_MEMORY_STATUS_EVENT, status);
    return status;
  };

  const memoryMetadata = async (paths: ProjectMemoryPaths): Promise<Pick<ProjectMemoryStatusEvent,
    "projectRoot" | "projectName" | "memoryFile" | "projectMemoryDir" | "exists" | "contentChars" | "estimatedTokens" | "processedSessions"
  >> => {
    const content = await readUtf8(paths.memoryFile);
    const contentChars = countCharacters(content);
    const persisted = await readPersistedMemoryState(paths);
    return {
      projectRoot: paths.projectRoot,
      projectName: paths.projectName,
      memoryFile: paths.memoryFile,
      projectMemoryDir: paths.projectMemoryDir,
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
  ): Promise<"started" | "busy" | "skipped" | "failed"> => {
    // Pi deliberately invalidates ExtensionContext after reload/session replacement.
    // A memory worker can outlive that context, so capture every value needed by its
    // completion callbacks before the first await and never retain `ctx` there.
    const cwd = ctx.cwd;
    const currentModel = ctx.model;
    const model = currentModel ? { provider: currentModel.provider, id: currentModel.id } : undefined;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const notify = snapshotNotifier(ctx);
    const attemptId = randomUUID();
    if (await memoryIsDisabled(cwd, env)) {
      publishStatus(cwd, { state: "disabled", source, attemptId, exists: false, injected: false, message: "当前目录已禁用项目记忆" });
      if (notifyStarted) notify?.("当前目录位于 .pi 内，已禁用记忆整理以防递归", "warning");
      return "skipped";
    }
    if (!model) {
      publishStatus(cwd, { state: "failed", source, attemptId, error: "当前没有可用于记忆整理的模型" });
      if (notifyStarted) notify?.("当前没有可用于记忆整理的模型", "warning");
      return "skipped";
    }
    if (!sessionFile || !(await pathExists(sessionFile))) {
      publishStatus(cwd, { state: "failed", source, attemptId, error: "当前会话没有可读取的 session 文件" });
      if (notifyStarted) notify?.("当前会话没有可读取的 session 文件", "warning");
      return "skipped";
    }

    try {
      const settings = await readMemorySettings(env);
      const { paths } = await prepareMemory(cwd, storageRoot, settings.projectMaxChars);
      const canonicalSessionFile = await canonicalPath(sessionFile);
      const persisted = await readPersistedMemoryState(paths);
      const processedSessions = [...new Set([...(status?.processedSessions ?? []), ...persisted.processedSessions])];
      const startedAt = Date.now();
      const result = await launchMemoryWorker({
        paths,
        sessionFile: canonicalSessionFile,
        provider: model.provider,
        model: model.id,
        maximum: settings.projectMaxChars,
        generationRules: settings.generationRules,
      }, options, {
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
            message: "正在整理当前项目记忆…",
          });
        },
        onComplete: async () => {
          try {
            const completedSessions = await recordProcessedSession(paths, canonicalSessionFile);
            const metadata = await memoryMetadata(paths);
            const completedAt = Date.now();
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
              message: "项目记忆整理完成",
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
    const cwd = ctx.cwd;
    const notify = snapshotNotifier(ctx);
    if (await memoryIsDisabled(cwd, env)) {
      publishStatus(cwd, { state: "disabled", source: "startup", exists: false, injected: false });
      return;
    }
    try {
      const settings = await readMemorySettings(env);
      const { paths } = await prepareMemory(cwd, storageRoot, settings.projectMaxChars);
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

  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx.cwd;
    const notify = snapshotNotifier(ctx);
    if (await memoryIsDisabled(cwd, env)) return undefined;
    if (event.systemPrompt.includes(MEMORY_PROMPT_MARKER)) return undefined;
    try {
      const settings = await readMemorySettings(env);
      const { paths, memory } = await prepareMemory(cwd, storageRoot, settings.projectMaxChars);
      const globalContent = settings.globalEnabled ? await readUtf8(paths.globalMemoryFile) : "";
      const entryFiles = settings.projectEnabled ? await listMemoryEntryFiles(paths) : [];
      publishStatus(cwd, {
        state: status?.state === "running" ? "running" : "idle",
        source: "prompt",
        ...await memoryMetadata(paths),
        injected: true,
        message: "项目记忆已注入当前会话",
      });
      return {
        systemPrompt: [
          event.systemPrompt,
          settings.globalEnabled ? buildGlobalMemoryPrompt(paths, globalContent, settings.globalMaxChars) : "",
          settings.projectEnabled ? buildProjectMemoryPrompt(paths, memory.content, settings.projectMaxChars, settings.generationRules, entryFiles) : "",
        ].filter(Boolean).join("\n\n"),
      };
    } catch (error) {
      notifyOnce(warningState, notify, error, "项目记忆注入失败");
      return undefined;
    }
  });

  // Counting in-process keeps the budget check working on Windows, where the
  // shell command the model used to run for it does not exist, and saves a
  // tool round trip everywhere else.
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return undefined;
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
    const rawPath = (event.input as Record<string, unknown>).path;
    if (typeof rawPath !== "string" || !rawPath.trim()) return undefined;
    const cwd = ctx.cwd;
    if (await memoryIsDisabled(cwd, env)) return undefined;
    try {
      const settings = await readMemorySettings(env);
      if (!settings.projectEnabled) return undefined;
      const paths = await resolveProjectMemoryPaths(cwd, storageRoot);
      const written = await canonicalPath(resolvePath(cwd, rawPath));
      if (written !== await canonicalPath(paths.memoryFile)) return undefined;
      const content = await readUtf8(paths.memoryFile);
      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text: buildMemorySizeNotice(paths.memoryFile, content, settings.projectMaxChars),
          },
        ],
      };
    } catch {
      return undefined;
    }
  });

  // 每轮回复结束都会触发 agent_settled，但记忆整理是一次完整的后台模型调用，
  // 一轮跑一次既贵又提炼不出新东西。这里只累计轮数，攒够配置的间隔才真正去跑。
  pi.on("agent_settled", async (_event, ctx) => {
    const cwd = ctx.cwd;
    const settings = await readMemorySettings(env);
    if (!settings.autoSummarize) return;
    if (await memoryIsDisabled(cwd, env)) return;
    try {
      const paths = await resolveProjectMemoryPaths(cwd, storageRoot);
      const turns = await recordMemoryTurn(paths);
      if (turns < settings.summarizeEveryTurns) return;
      await resetMemoryTurns(paths);
    } catch (error) {
      notifyOnce(backgroundWarningState, snapshotNotifier(ctx), error, "记忆整理轮次计数失败");
      return;
    }
    await summarizeSession(ctx, false, "automatic");
  });

}
