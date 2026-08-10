import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_CHILD_TOOLS,
  type ChildSessionHandle,
  childSessionDirectory,
  createChildSession,
  reopenChildSession,
  scanResumableChildren,
} from "./subagents/child.ts";
import {
  formatProfileCatalog,
  loadProfiles,
  type SubagentProfile,
} from "./subagents/profiles.ts";
import {
  acquireRunControl,
  type ChildRun,
  createRunId,
  prepareRunForResume,
  runIsLive,
  SubagentRegistry,
} from "./subagents/registry.ts";
import type {
  SubagentChildMeta,
  SubagentRpcRequest,
  SubagentToolDetails,
} from "./subagents/types.ts";
import {
  SUBAGENT_ACTIVITY_CHANNEL,
  SUBAGENT_RPC_REQUEST_CHANNEL,
  SUBAGENT_RUN_ENTRY_TYPE,
  subagentRpcReplyChannel,
} from "./subagents/types.ts";
import {
  createSubagentWorktree,
  findGitRepoRoot,
  removeSubagentWorktreeIfClean,
  subagentWorktreeBranch,
} from "./subagents/worktree.ts";
import { join } from "node:path";

const MAX_CONCURRENT_CHILDREN = 8;
export const SUBAGENT_FLUSH_INTERVAL_MS = 250;
const FLUSH_INTERVAL_MS = SUBAGENT_FLUSH_INTERVAL_MS;
const FINAL_OUTPUT_PREVIEW_CHARS = 8_000;
const MAX_BASH_BUFFER_CHARS = 20_000;
const STOP_SETTLE_WAIT_MS = 300;
const DEFAULT_RESUME_PROMPT = "继续之前的任务：检查并完成未完成的工作，然后汇报最终结果。";
const BUILTIN_AGENTS_DIR = fileURLToPath(new URL("../agents", import.meta.url));

const SUBAGENT_ACTIONS = ["run", "status", "stop", "resume"] as const;

const SubagentParams = Type.Object({
  action: Type.Optional(
    StringEnum(SUBAGENT_ACTIONS, { description: "run 派发；status 查询；stop 停止；resume 复用已完成的子 Agent。默认 run。" }),
  ),
  agent: Type.Optional(Type.String({ description: "子 Agent profile 名称（如 explore、reviewer、worker），会套用预设的提示词、模型和工具范围；省略则用默认配置派发。" })),
  task: Type.Optional(Type.String({ description: "action=run 时必填；action=resume 时作为追加指示，省略则继续原任务。" })),
  model: Type.Optional(Type.String({ description: '模型覆盖，格式 "provider/model-id"。省略则继承当前会话模型。' })),
  background: Type.Optional(Type.Boolean({ description: "true 时立即返回 runId，子 Agent 在后台运行，完成后会自动汇报。" })),
  worktree: Type.Optional(Type.Boolean({ description: "true 时子 Agent 在独立的 git worktree 分支上工作，适合并行写入；省略则跟随 profile 设置（worker 默认开启）。" })),
  runId: Type.Optional(Type.String({ description: "action=status/stop/resume 时指定目标运行；status 省略则列出全部。" })),
});

interface ResolvedModel {
  model?: Model<never>;
  label?: string;
}

interface SubagentToolOutcome {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentToolDetails | { error: string };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…（已截断）`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function modelLabel(model: Model<never> | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function resolveModel(query: string | undefined, ctx: ExtensionContext): ResolvedModel | { error: string } {
  if (!query || !query.trim()) {
    const inherited = ctx.model as Model<never> | undefined;
    return { model: inherited, label: modelLabel(inherited) };
  }
  const normalized = query.trim();
  const separator = normalized.indexOf("/");
  if (separator <= 0 || separator === normalized.length - 1) {
    return { error: `模型格式无效：${normalized}，应为 provider/model-id。` };
  }
  const provider = normalized.slice(0, separator).trim();
  const modelId = normalized.slice(separator + 1).trim();
  const model = ctx.modelRegistry.find(provider, modelId) as Model<never> | undefined;
  if (!model) return { error: `未找到模型：${normalized}。` };
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) return { error: `模型 ${normalized} 尚未配置 API Key。` };
  return { model, label: modelLabel(model) };
}

export function resumeToolsForRun(run: ChildRun, profile?: SubagentProfile): string[] | undefined {
  if (run.tools) return [...run.tools];
  if (profile) return [...(profile.tools ?? DEFAULT_CHILD_TOOLS)];
  return run.agent === "default" ? [...DEFAULT_CHILD_TOOLS] : undefined;
}

export function resumeCwdForRun(run: ChildRun, fallbackCwd: string): { cwd?: string; error?: string } {
  if (run.worktreeRequired || run.worktreePath) {
    if (!run.worktreePath || !existsSync(run.worktreePath)) {
      return { error: `子 Agent worktree 已不存在，拒绝在主工作区继续运行：${run.worktreePath ?? "未知路径"}` };
    }
    return { cwd: run.worktreePath };
  }
  return { cwd: fallbackCwd };
}

export async function disposeRunsForShutdown(runs: ChildRun[]): Promise<void> {
  for (const run of runs) run.stopRequested = true;
  await Promise.allSettled(runs.map(async (run) => {
    try {
      if (run.dispose) await run.dispose();
      else if (run.session) await run.session.abort().catch(() => undefined);
    } finally {
      run.session = undefined;
      run.dispose = undefined;
    }
  }));
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const preferred = record.path ?? record.command ?? record.pattern ?? record.url ?? record.file_path;
  if (typeof preferred === "string") return truncate(preferred, 400);
  try {
    return truncate(JSON.stringify(args), 200);
  } catch {
    return "";
  }
}

function extractAssistantParts(message: unknown): { text: string; thinking: string } {
  if (!message || typeof message !== "object") return { text: "", thinking: "" };
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  let text = "";
  let thinking = "";
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown; thinking?: unknown };
    if (record.type === "text" && typeof record.text === "string") text += record.text;
    else if (record.type === "thinking" && typeof record.thinking === "string") thinking += record.thinking;
  }
  return { text, thinking };
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function formatCompletionText(run: ChildRun): string {
  const duration = formatDuration((run.finishedAt ?? Date.now()) - run.startedAt);
  const lines = [
    `子 Agent 已完成（runId=${run.runId}${run.background ? "，后台运行" : ""}）`,
    `模型：${run.model ?? "继承"} · 耗时 ${duration} · ${run.turnCount} 轮 · ${run.toolCount} 次工具调用 · ${run.tokens} tokens`,
  ];
  if (run.sessionFile) lines.push(`会话文件：${run.sessionFile}`);
  if (run.worktreePath) {
    lines.push(`Worktree：${run.worktreePath}（分支 ${subagentWorktreeBranch(run.runId)}）`);
    if (run.status === "completed") {
      lines.push("改动保留在该 worktree 中，请检查后自行合并回主工作区（如合并分支或直接拷贝改动），确认无误后可清理。");
    }
  }
  if (run.finalOutput) lines.push("", "最终输出：", truncate(run.finalOutput, FINAL_OUTPUT_PREVIEW_CHARS));
  else lines.push("", "最终输出：（无文本输出）");
  return lines.join("\n");
}

function formatFailureText(run: ChildRun): string {
  const reason = run.status === "stopped" ? "已停止" : "执行失败";
  const lines = [`子 Agent ${reason}（runId=${run.runId}）`];
  if (run.error) lines.push(`错误：${run.error}`);
  if (run.finalOutput) lines.push("", "停止前的最后输出：", truncate(run.finalOutput, FINAL_OUTPUT_PREVIEW_CHARS));
  return lines.join("\n");
}

function formatStatusText(run: ChildRun): string {
  const duration = formatDuration((run.finishedAt ?? Date.now()) - run.startedAt);
  const lines = [
    `运行 ${run.runId} · ${run.agent} · ${run.status}${run.background ? " · 后台" : ""}`,
    `任务：${truncate(run.task, 400)}`,
    `模型：${run.model ?? "继承"} · 已运行 ${duration} · ${run.turnCount} 轮 · ${run.toolCount} 次工具调用`,
  ];
  if (run.currentTool) lines.push(`当前工具：${run.currentTool}${run.currentPath ? ` ${run.currentPath}` : ""}`);
  if (run.recentTools.length) {
    lines.push("最近工具：");
    for (const entry of run.recentTools.slice(-5)) lines.push(`  ${entry.tool}${entry.args ? ` ${truncate(entry.args, 120)}` : ""}`);
  }
  if (run.error) lines.push(`错误：${run.error}`);
  if (run.sessionFile) lines.push(`会话文件：${run.sessionFile}`);
  if (run.worktreePath) lines.push(`Worktree：${run.worktreePath}（分支 ${subagentWorktreeBranch(run.runId)}）`);
  return lines.join("\n");
}

export default function subagentsExtension(pi: ExtensionAPI): void {
  const registry = new SubagentRegistry();
  const updateSinks = new Map<string, (details: SubagentToolDetails) => void>();
  const dirtyRuns = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let detached = false;
  let sessionCwd: string | undefined;
  let sessionDir: string | undefined;
  let sessionId: string | undefined;
  let profiles = new Map<string, SubagentProfile>();

  const reloadProfiles = (cwd: string): void => {
    profiles = loadProfiles({
      builtinDir: BUILTIN_AGENTS_DIR,
      userDir: join(getAgentDir(), "agents"),
      projectDir: join(cwd, ".suocode", "agents"),
    });
  };

  const flushNow = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (detached) return;
    const ids = [...dirtyRuns];
    dirtyRuns.clear();
    const runs = ids
      .map((id) => registry.get(id))
      .filter((run): run is ChildRun => run !== undefined);
    if (runs.length === 0) return;
    pi.events.emit(SUBAGENT_ACTIVITY_CHANNEL, {
      version: 1,
      activities: runs.map((run) => registry.toActivity(run)),
    });
    for (const run of runs) {
      const sink = updateSinks.get(run.runId);
      if (sink) sink(registry.toDetails(run));
    }
  };

  const markDirty = (runId: string): void => {
    if (detached) return;
    dirtyRuns.add(runId);
    flushTimer ??= setTimeout(flushNow, FLUSH_INTERVAL_MS);
  };

  const handleChildEvent = (run: ChildRun, event: AgentSessionEvent): void => {
    switch (event.type) {
      case "tool_execution_start": {
        const argsSummary = summarizeArgs(event.args);
        run.currentTool = event.toolName;
        run.currentPath = argsSummary || undefined;
        registry.recordRecentTool(run, event.toolName, argsSummary);
        let expanded: string | undefined;
        try {
          expanded = truncate(JSON.stringify(event.args, null, 2), 16_000);
        } catch {
          expanded = undefined;
        }
        registry.recordToolCall(run, {
          text: `${event.toolName}${argsSummary ? ` ${truncate(argsSummary, 200)}` : ""}`,
          expandedText: expanded,
        });
        markDirty(run.runId);
        break;
      }
      case "tool_execution_end": {
        run.toolCount += 1;
        if (run.currentTool === event.toolName) {
          run.currentTool = undefined;
          run.currentPath = undefined;
        }
        if (event.toolName === "bash" && run.bashBuffer) {
          registry.recordRecentOutput(run, run.bashBuffer);
          run.bashBuffer = "";
        }
        markDirty(run.runId);
        break;
      }
      case "bash_execution_update": {
        run.bashBuffer += event.delta;
        if (run.bashBuffer.length > MAX_BASH_BUFFER_CHARS) run.bashBuffer = run.bashBuffer.slice(-MAX_BASH_BUFFER_CHARS);
        break;
      }
      case "agent_end": {
        run.turnCount += 1;
        markDirty(run.runId);
        break;
      }
      case "message_end": {
        const role = (event.message as { role?: unknown }).role;
        if (role !== "assistant") break;
        const parts = extractAssistantParts(event.message);
        if (parts.text) {
          run.finalOutput = parts.text;
          registry.recordMessage(run, { role: "assistant", text: parts.text, thinking: parts.thinking || undefined });
        }
        markDirty(run.runId);
        break;
      }
      default:
        break;
    }
  };

  const failRun = (run: ChildRun, status: "failed" | "stopped", error?: string): void => {
    run.status = status;
    run.error = error;
    run.finishedAt = Date.now();
    updateSinks.delete(run.runId);
    markDirty(run.runId);
    flushNow();
  };

  const collectStats = (run: ChildRun, session: AgentSession): void => {
    try {
      const stats = session.getSessionStats();
      run.tokens = stats.tokens.total;
      run.toolCount = stats.toolCalls;
      run.turnCount = stats.assistantMessages;
    } catch {
      // 统计失败不影响运行结果。
    }
  };

  const notifyParent = (run: ChildRun): void => {
    if (detached) return;
    try {
      pi.appendEntry(SUBAGENT_RUN_ENTRY_TYPE, registry.toActivity(run));
    } catch {
      // 持久化失败不阻断唤醒。
    }
    const summary = run.status === "completed" ? formatCompletionText(run) : formatFailureText(run);
    pi.sendMessage(
      {
        customType: "subagent-complete",
        content: [{ type: "text", text: `${summary}\n\n（该运行的 runId 为 ${run.runId}，后续如需查询、停止或复用，可针对此 runId 操作。）` }],
        display: true,
        details: registry.toDetails(run),
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  const runDetached = (run: ChildRun, handle: ChildSessionHandle, task: string): void => {
    run.session = handle.session;
    run.sessionFile = handle.sessionFile;
    run.dispose = handle.dispose;
    markDirty(run.runId);
    flushNow();
    void (async () => {
      let promptError: unknown;
      try {
        await handle.session.prompt(task, { source: "extension" });
      } catch (error) {
        promptError = error;
      }
      collectStats(run, handle.session);
      if (run.stopRequested) failRun(run, "stopped");
      else if (promptError) failRun(run, "failed", errorMessage(promptError));
      else {
        run.status = "completed";
        run.finishedAt = Date.now();
        markDirty(run.runId);
        flushNow();
      }
      await handle.dispose().catch(() => undefined);
      run.session = undefined;
      run.dispose = undefined;
      markDirty(run.runId);
      flushNow();
      notifyParent(run);
    })();
  };

  const runBlocking = async (
    run: ChildRun,
    handle: ChildSessionHandle,
    task: string,
    signal: AbortSignal | undefined,
  ): Promise<SubagentToolOutcome> => {
    run.session = handle.session;
    run.sessionFile = handle.sessionFile;
    run.dispose = handle.dispose;
    markDirty(run.runId);
    flushNow();

    const abortListener = (): void => {
      void handle.session.abort().catch(() => undefined);
    };
    signal?.addEventListener("abort", abortListener, { once: true });

    let promptError: unknown;
    try {
      await handle.session.prompt(task, { source: "extension" });
    } catch (error) {
      promptError = error;
    }
    signal?.removeEventListener("abort", abortListener);

    collectStats(run, handle.session);

    if (signal?.aborted || run.stopRequested) failRun(run, "stopped");
    else if (promptError) failRun(run, "failed", errorMessage(promptError));
    else {
      run.status = "completed";
      run.finishedAt = Date.now();
      updateSinks.delete(run.runId);
      markDirty(run.runId);
      flushNow();
    }

    await handle.dispose().catch(() => undefined);
    run.session = undefined;
    run.dispose = undefined;

    const details = registry.toDetails(run);
    if (run.status === "completed") {
      return { content: [{ type: "text", text: formatCompletionText(run) }], details };
    }
    return { content: [{ type: "text", text: formatFailureText(run) }], details };
  };

  const childSessionDir = (): string | undefined => {
    return sessionDir && sessionId ? childSessionDirectory(sessionDir, sessionId) : undefined;
  };

  const adoptScannedRun = (query: string): ChildRun | undefined => {
    const dir = childSessionDir();
    if (!dir) return undefined;
    if (!sessionId) return undefined;
    const candidates = scanResumableChildren(dir, { parentSessionId: sessionId })
      .filter((child) => child.meta.runId === query || child.meta.runId.startsWith(query));
    if (candidates.length !== 1) return undefined;
    const { meta, sessionFile } = candidates[0];
    const run: ChildRun = {
      runId: meta.runId,
      agent: meta.agent || "default",
      task: meta.task,
      model: meta.model,
      tools: meta.tools ? [...meta.tools] : undefined,
      background: meta.background,
      status: "stopped",
      sessionFile,
      worktreeRequired: meta.worktree === true || Boolean(meta.worktreePath),
      worktreePath: meta.worktreePath,
      startedAt: meta.startedAt,
      finishedAt: meta.startedAt,
      recentTools: [],
      recentOutput: [],
      messages: [],
      toolCalls: [],
      toolCount: 0,
      turnCount: 0,
      tokens: 0,
      bashBuffer: "",
    };
    registry.add(run);
    return run;
  };

  const findRun = (query: string): ChildRun | undefined => {
    return registry.get(query) ?? adoptScannedRun(query);
  };

  const stopRun = async (run: ChildRun): Promise<void> => {
    const releaseControl = acquireRunControl(run, "stop");
    try {
      if (!runIsLive(run)) return;
      run.stopRequested = true;
      await run.session?.abort().catch(() => undefined);
      await sleep(STOP_SETTLE_WAIT_MS);
      if (runIsLive(run)) failRun(run, "stopped");
      if (run.status === "stopped" && run.worktreePath && run.worktreeRepoRoot) {
        // Keep the original path in metadata even when a clean checkout is removed.
        // Resume must fail closed instead of silently switching a writer to the parent cwd.
        await removeSubagentWorktreeIfClean(run.worktreeRepoRoot, run.worktreePath).catch(() => false);
      }
    } finally {
      releaseControl();
    }
  };

  const reopenForResume = async (run: ChildRun): Promise<{ handle?: ChildSessionHandle; error?: string }> => {
    if (!run.sessionFile || !existsSync(run.sessionFile)) {
      return { error: `子 Agent 会话文件不存在：${run.sessionFile ?? "未知"}` };
    }
    const resolvedCwd = resumeCwdForRun(run, sessionCwd ?? process.cwd());
    if (!resolvedCwd.cwd) return { error: resolvedCwd.error ?? "无法确定子 Agent 恢复目录。" };
    const profile = profiles.get(run.agent);
    const tools = resumeToolsForRun(run, profile);
    if (!tools) return { error: `子 Agent profile ${run.agent} 已不存在，且会话未保存原工具权限，拒绝以更宽权限恢复。` };
    try {
      const handle = await reopenChildSession({
        sessionFile: run.sessionFile,
        cwd: resolvedCwd.cwd,
        agentDir: getAgentDir(),
        tools,
        systemPrompt: profile?.systemPrompt,
        onEvent: (event) => handleChildEvent(run, event),
      });
      return { handle };
    } catch (error) {
      return { error: `子 Agent 会话恢复失败：${errorMessage(error)}` };
    }
  };

  const beginResume = (run: ChildRun, background: boolean, parentToolId?: string): void => {
    prepareRunForResume(run, background, parentToolId);
    markDirty(run.runId);
    flushNow();
  };

  const executeRun = async (
    toolCallId: string,
    params: { agent?: string; task?: string; model?: string; background?: boolean; worktree?: boolean },
    signal: AbortSignal | undefined,
    onUpdate: ((update: { content: Array<{ type: "text"; text: string }>; details: SubagentToolDetails }) => void) | undefined,
    ctx: ExtensionContext,
  ): Promise<SubagentToolOutcome> => {
    const task = (params.task ?? "").trim();
    if (!task) throw new Error("缺少子 Agent 任务描述（task）。");
    if (registry.liveCount() >= MAX_CONCURRENT_CHILDREN) {
      throw new Error(`并发子 Agent 已达上限（${MAX_CONCURRENT_CHILDREN}），请等待已有运行结束。`);
    }
    const profileName = params.agent?.trim();
    const profile = profileName ? profiles.get(profileName) : undefined;
    if (profileName && !profile) {
      throw new Error(`未找到子 Agent profile：${profileName}。\n${formatProfileCatalog(profiles)}`);
    }
    const resolved = resolveModel(params.model ?? profile?.model, ctx);
    if ("error" in resolved) throw new Error(resolved.error);

    const background = params.background === true;
    const useWorktree = params.worktree ?? profile?.worktree ?? false;
    const tools = [...(profile?.tools ?? DEFAULT_CHILD_TOOLS)];
    const run: ChildRun = {
      runId: createRunId(),
      parentToolId: toolCallId,
      agent: profile?.name ?? (profileName || "default"),
      task,
      model: resolved.label,
      tools,
      background,
      status: "running",
      worktreeRequired: useWorktree,
      startedAt: Date.now(),
      recentTools: [],
      recentOutput: [],
      messages: [],
      toolCalls: [],
      toolCount: 0,
      turnCount: 0,
      tokens: 0,
      bashBuffer: "",
    };
    registry.add(run);
    if (!background) {
      updateSinks.set(run.runId, (details) => {
        onUpdate?.({ content: [{ type: "text", text: `子 Agent ${run.runId} 运行中（${run.status}）` }], details });
      });
    }
    markDirty(run.runId);
    flushNow();

    const meta: SubagentChildMeta = {
      runId: run.runId,
      agent: run.agent,
      task: run.task,
      model: run.model,
      tools: [...tools],
      background,
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile(),
      worktree: useWorktree,
      startedAt: run.startedAt,
    };

    let childCwd = ctx.cwd;
    if (useWorktree) {
      const repoRoot = await findGitRepoRoot(ctx.cwd);
      if (!repoRoot) {
        failRun(run, "failed", "当前目录不是 git 仓库，无法创建 worktree 隔离环境。");
        throw new Error("worktree 隔离需要在 git 仓库内运行，当前目录不是 git 仓库。");
      }
      try {
        const created = await createSubagentWorktree(repoRoot, run.runId);
        run.worktreePath = created.worktreePath;
        run.worktreeRepoRoot = repoRoot;
        childCwd = created.worktreePath;
        meta.worktreePath = created.worktreePath;
        markDirty(run.runId);
        flushNow();
      } catch (error) {
        failRun(run, "failed", errorMessage(error));
        throw error;
      }
    }

    let handle: ChildSessionHandle;
    try {
      handle = await createChildSession({
        cwd: childCwd,
        agentDir: getAgentDir(),
        parentSessionDir: ctx.sessionManager.getSessionDir(),
        parentSessionId: ctx.sessionManager.getSessionId(),
        model: resolved.model,
        tools,
        systemPrompt: profile?.systemPrompt,
        meta,
        onEvent: (event) => handleChildEvent(run, event),
      });
    } catch (error) {
      failRun(run, "failed", errorMessage(error));
      if (run.worktreePath && run.worktreeRepoRoot) {
        await removeSubagentWorktreeIfClean(run.worktreeRepoRoot, run.worktreePath).catch(() => false);
        run.worktreePath = undefined;
        run.worktreeRepoRoot = undefined;
      }
      throw new Error(`子 Agent 会话创建失败：${errorMessage(error)}`);
    }

    if (detached || signal?.aborted || run.stopRequested || !runIsLive(run)) {
      run.stopRequested = true;
      await handle.dispose().catch(() => undefined);
      failRun(run, "stopped");
      throw new Error("父会话已关闭，子 Agent 未启动。");
    }

    if (background) {
      runDetached(run, handle, task);
      return {
        content: [{ type: "text", text: `子 Agent 已在后台派发（runId=${run.runId}）。完成后会自动汇报；期间可用 action=status 查询进度，action=stop 停止。` }],
        details: registry.toDetails(run),
      };
    }
    return runBlocking(run, handle, task, signal);
  };

  const executeStatus = (params: { runId?: string }): SubagentToolOutcome => {
    const query = params.runId?.trim();
    if (!query) {
      const runs = registry.list();
      const catalog = formatProfileCatalog(profiles);
      if (runs.length === 0) return { content: [{ type: "text", text: `当前会话还没有派发过子 Agent。\n${catalog}` }], details: { error: "no-runs" } };
      const lines = runs.map((run) => `${run.runId} · ${run.agent} · ${run.status}${run.background ? " · 后台" : ""} · ${truncate(run.task, 120)}`);
      return { content: [{ type: "text", text: `共 ${runs.length} 个子 Agent 运行：\n${lines.join("\n")}\n\n${catalog}` }], details: { error: "no-runs" } };
    }
    const run = findRun(query);
    if (!run) throw new Error(`未找到子 Agent 运行：${query}`);
    return { content: [{ type: "text", text: formatStatusText(run) }], details: registry.toDetails(run) };
  };

  const executeStop = async (params: { runId?: string }): Promise<SubagentToolOutcome> => {
    const query = params.runId?.trim();
    if (!query) throw new Error("缺少要停止的运行标识（runId）。");
    const run = registry.get(query);
    if (!run) throw new Error(`未找到子 Agent 运行：${query}`);
    if (!runIsLive(run) && !run.controlOperation) {
      return { content: [{ type: "text", text: `子 Agent ${run.runId} 已结束（${run.status}），无需停止。` }], details: registry.toDetails(run) };
    }
    await stopRun(run);
    return { content: [{ type: "text", text: `子 Agent ${run.runId} 已停止。` }], details: registry.toDetails(run) };
  };

  const executeResume = async (
    toolCallId: string,
    params: { runId?: string; task?: string; background?: boolean },
    signal: AbortSignal | undefined,
    onUpdate: ((update: { content: Array<{ type: "text"; text: string }>; details: SubagentToolDetails }) => void) | undefined,
  ): Promise<SubagentToolOutcome> => {
    const query = params.runId?.trim();
    if (!query) throw new Error("缺少要复用的运行标识（runId）。");
    const run = findRun(query);
    if (!run) throw new Error(`未找到子 Agent 运行：${query}`);
    const releaseControl = acquireRunControl(run, "resume");
    let immediateOutcome: SubagentToolOutcome | undefined;
    let blockingOutcome: Promise<SubagentToolOutcome> | undefined;
    try {
      if (runIsLive(run)) {
        throw new Error(`子 Agent ${run.runId} 仍在执行，可用 action=status 查看进度。`);
      }
      if (registry.liveCount() >= MAX_CONCURRENT_CHILDREN) {
        throw new Error(`并发子 Agent 已达上限（${MAX_CONCURRENT_CHILDREN}），请等待已有运行结束。`);
      }
      const reopened = await reopenForResume(run);
      if (!reopened.handle) throw new Error(reopened.error ?? "子 Agent 会话恢复失败。");
      if (detached || signal?.aborted) {
        await reopened.handle.dispose().catch(() => undefined);
        throw new Error("父会话已关闭，无法恢复子 Agent。");
      }

      const followUp = (params.task ?? "").trim() || DEFAULT_RESUME_PROMPT;
      const background = params.background === true;
      beginResume(run, background, toolCallId);
      if (background) {
        runDetached(run, reopened.handle, followUp);
        immediateOutcome = {
          content: [{ type: "text", text: `子 Agent ${run.runId} 已在后台继续运行，完成后会自动汇报。` }],
          details: registry.toDetails(run),
        };
      } else {
        updateSinks.set(run.runId, (details) => {
          onUpdate?.({ content: [{ type: "text", text: `子 Agent ${run.runId} 运行中（${run.status}）` }], details });
        });
        // Calling the async function attaches the session before the control lock
        // is released, so a concurrent stop can never observe a live run without a handle.
        blockingOutcome = runBlocking(run, reopened.handle, followUp, signal);
      }
    } finally {
      releaseControl();
    }
    if (immediateOutcome) return immediateOutcome;
    return blockingOutcome!;
  };

  pi.on("session_start", (_event, ctx) => {
    sessionCwd = ctx.cwd;
    sessionDir = ctx.sessionManager.getSessionDir();
    sessionId = ctx.sessionManager.getSessionId();
    reloadProfiles(ctx.cwd);
  });

  pi.events.on(SUBAGENT_RPC_REQUEST_CHANNEL, async (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const request = raw as SubagentRpcRequest;
    if (!request.requestId || typeof request.requestId !== "string") return;
    const replyChannel = subagentRpcReplyChannel(request.requestId);
    const replyError = (message: string): void => {
      pi.events.emit(replyChannel, { version: 1, requestId: request.requestId, success: false, error: { message } });
    };
    try {
      const id = request.params?.id?.trim() ?? "";
      if (request.method === "status") {
        const run = id ? findRun(id) : undefined;
        if (!run) return replyError(`未找到子 Agent 运行：${id || "（缺少 id）"}`);
        pi.events.emit(replyChannel, { version: 1, requestId: request.requestId, success: true, data: { activity: registry.toActivity(run) } });
        return;
      }
      if (request.method === "stop") {
        const run = id ? registry.get(id) : undefined;
        if (!run) return replyError(`未找到子 Agent 运行：${id || "（缺少 id）"}`);
        await stopRun(run);
        pi.events.emit(replyChannel, { version: 1, requestId: request.requestId, success: true, data: { activity: registry.toActivity(run) } });
        return;
      }
      if (request.method === "resume") {
        const run = id ? findRun(id) : undefined;
        if (!run) return replyError(`未找到子 Agent 运行：${id || "（缺少 id）"}`);
        const releaseControl = acquireRunControl(run, "resume");
        try {
          if (runIsLive(run)) return replyError(`子 Agent ${run.runId} 仍在执行。`);
          if (registry.liveCount() >= MAX_CONCURRENT_CHILDREN) {
            return replyError(`并发子 Agent 已达上限（${MAX_CONCURRENT_CHILDREN}），请等待已有运行结束。`);
          }
          const reopened = await reopenForResume(run);
          if (!reopened.handle) return replyError(reopened.error ?? "子 Agent 会话恢复失败。");
          if (detached) {
            await reopened.handle.dispose().catch(() => undefined);
            return replyError("父会话已关闭，无法恢复子 Agent。");
          }
          beginResume(run, true);
          runDetached(run, reopened.handle, DEFAULT_RESUME_PROMPT);
          pi.events.emit(replyChannel, { version: 1, requestId: request.requestId, success: true, data: { activity: registry.toActivity(run) } });
        } finally {
          releaseControl();
        }
        return;
      }
      replyError(`不支持的子 Agent 控制方法：${String(request.method)}`);
    } catch (error) {
      replyError(errorMessage(error));
    }
  });

  pi.on("session_shutdown", async () => {
    detached = true;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    dirtyRuns.clear();
    updateSinks.clear();
    const runs = registry.list();
    await disposeRunsForShutdown(runs);
    registry.clear();
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "派发并管理子 Agent。子 Agent 在独立会话中运行，适合委派需要大量上下文的任务（搜索、阅读、代码修改），结果汇总后返回，不占用主会话上下文。",
    promptSnippet: "subagent: 派发子 Agent 在独立会话中执行任务",
    promptGuidelines: [
      "需要大量文件读取、搜索或独立成块的子任务优先委派给子 Agent；多个相互独立的子任务应在同一条消息中发起多个 subagent 调用以并行执行。",
      "传给子 Agent 的 task 必须自包含：交代背景、关键路径和期望的产出格式，不要假设它能看到主会话的上下文。",
      "按角色选择 profile：只读侦察用 explore，代码评审用 reviewer，需要写代码用 worker；用 action=status（不带 runId）可查看可用的 profile 列表。",
      "不急于拿到结果、或想同时推进其他工作时用 background:true 派发；子 Agent 完成后会自动汇报，无需轮询，需要进度时用 action=status 查询。",
      "已完成的子 Agent 可以用 action=resume 复用其会话上下文继续相关工作，比重新派发更省上下文。",
      "多个子 Agent 并行写同一个仓库时务必用 worktree:true（worker profile 默认开启），各自在独立 git worktree 分支上工作避免互相覆盖；完成后改动留在 worktree，由你审阅并合并。",
    ],
    parameters: SubagentParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const action = params.action ?? "run";
      const forwardUpdate = onUpdate
        ? (update: { content: Array<{ type: "text"; text: string }>; details: SubagentToolDetails }) => onUpdate(update)
        : undefined;
      if (action === "status") return executeStatus(params);
      if (action === "stop") return executeStop(params);
      if (action === "resume") return executeResume(toolCallId, params, signal, forwardUpdate);
      return executeRun(toolCallId, params, signal, forwardUpdate, ctx);
    },
  });
}
