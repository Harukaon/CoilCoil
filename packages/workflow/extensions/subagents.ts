import { existsSync, readFileSync } from "node:fs";
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
  childToolsForPlatform,
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
    StringEnum(SUBAGENT_ACTIONS, { description: "run dispatches; status queries; stop stops; resume continues a finished subagent. Default run." }),
  ),
  agent: Type.Optional(Type.String({ description: "Subagent profile name (such as explore, reviewer, worker); it applies the preset prompt, the user-configured model and the tool scope. Omit it to dispatch with the default configuration." })),
  task: Type.Optional(Type.String({ description: "Required for action=run; with action=resume it is an extra instruction, and omitting it continues the original task." })),
  background: Type.Optional(Type.Boolean({ description: "Default false: after dispatch, block until the subagent finishes and return its result. When true, return a runId immediately; the subagent runs in the background and reports back automatically when it is done." })),
  worktree: Type.Optional(Type.Boolean({ description: "When true the subagent works on its own git worktree branch, which suits parallel writes; when omitted it follows the profile setting (on by default for worker)." })),
  runId: Type.Optional(Type.String({ description: "Target run for action=status/stop/resume; with status, omit it to list all runs." })),
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

/** The profiles the short-lived single-`model` settings file used to cover. */
const LEGACY_SINGLE_MODEL_PROFILES: readonly string[] = ["explore", "worker", "reviewer"];

/**
 * Resolve the model the user chose for one profile, from current or legacy settings.
 *
 * Any profile can have one, built-in or user-written: the settings file is a map from
 * profile name to `provider/model-id`, and a name that is not in it has none chosen.
 */
export function configuredSubagentModel(value: unknown, profileName: string | undefined): string {
  if (!profileName) return "";
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const models = record.models && typeof record.models === "object" && !Array.isArray(record.models)
    ? record.models as Record<string, unknown>
    : {};
  if (Object.hasOwn(models, profileName)) {
    const selected = models[profileName];
    if (typeof selected === "string") return selected.trim();
  }
  // Preserve the behavior of the short-lived single-model configuration. It only ever
  // covered the profiles that existed then, so it does not reach newer or user-written ones.
  return LEGACY_SINGLE_MODEL_PROFILES.includes(profileName) && typeof record.model === "string"
    ? record.model.trim()
    : "";
}

function readConfiguredSubagentModel(profileName: string | undefined): string {
  try {
    const path = join(getAgentDir(), "subagent-settings.json");
    if (!existsSync(path)) return "";
    return configuredSubagentModel(JSON.parse(readFileSync(path, "utf8")), profileName);
  } catch {
    return "";
  }
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

function extractToolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return result === undefined ? "" : String(result);
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = (part as { text?: unknown }).text;
      return typeof value === "string" ? [value] : [];
    }).join("\n");
    if (text) return text;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
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
  let sessionContext: ExtensionContext | undefined;
  let profiles = new Map<string, SubagentProfile>();

  const reloadProfiles = (cwd: string): void => {
    profiles = loadProfiles({
      builtinDir: BUILTIN_AGENTS_DIR,
      userDir: join(getAgentDir(), "agents"),
      projectDir: join(cwd, ".coilcoil", "agents"),
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
        registry.recordTimelineToolStart(run, {
          id: event.toolCallId,
          tool: event.toolName,
          args: argsSummary,
          expandedArgs: expanded,
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
        registry.recordTimelineToolEnd(run, {
          id: event.toolCallId,
          output: extractToolResultText(event.result),
          failed: event.isError,
        });
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
        if (parts.text) run.finalOutput = parts.text;
        if (parts.text || parts.thinking) {
          const message = { role: "assistant", text: parts.text, thinking: parts.thinking || undefined };
          registry.recordMessage(run, message);
          registry.recordTimelineMessage(run, message);
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
      modelInherited: meta.modelInherited,
      tools: meta.tools ? [...meta.tools] : undefined,
      background: meta.background,
      status: "stopped",
      sessionFile,
      worktreeRequired: meta.worktree === true || Boolean(meta.worktreePath),
      worktreePath: meta.worktreePath,
      planId: meta.planId,
      startedAt: meta.startedAt,
      finishedAt: meta.startedAt,
      recentTools: [],
      recentOutput: [],
      messages: [],
      toolCalls: [],
      timeline: [],
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
        parentEvents: pi.events,
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
    params: { agent?: string; task?: string; background?: boolean; worktree?: boolean; planId?: string },
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
      throw new Error(`未找到子 Agent profile：${profileName}。\n${formatProfileCatalog(profiles, (item) => readConfiguredSubagentModel(item.name) || item.model)}`);
    }
    // 每个 profile 用哪个模型完全由用户配置；工具 schema 里没有 model 参数，Agent
    // 无法绕过。自定义 profile 可以在自己的 frontmatter 里写 model，那同样算配置
    // 过了。
    //
    // 没配置就不给用。以前这里退回主会话模型，等于让派发方替用户做了选择——一个
    // 本该跑在便宜模型上的侦察子 Agent，会悄悄用主会话那个贵的跑完。宁可直接不
    // 可用，让 Agent 换别的办法，也好过用错模型跑一遍。
    const configuredModel = readConfiguredSubagentModel(profile?.name);
    const modelQuery = configuredModel || profile?.model;
    if (!modelQuery || !modelQuery.trim()) {
      const who = profile?.name ? `子 Agent「${profile.name}」` : "默认子 Agent";
      throw new Error(
        `${who}不可用：用户还没有为它配置模型。`
        + `\n模型只能由用户在「运行时 → 子 Agent 模型」里配置，你无法代为选择，也不要重试这次派发。`
        + `\n请改用其他方式完成这项工作（例如自己直接读文件、跑命令），或换一个已配置模型的 profile。`
        + `\n${formatProfileCatalog(profiles, (item) => readConfiguredSubagentModel(item.name) || item.model)}`,
      );
    }
    const modelInherited = false;
    const resolved = resolveModel(modelQuery, ctx);
    if ("error" in resolved) throw new Error(resolved.error);

    const background = params.background === true;
    const useWorktree = params.worktree ?? profile?.worktree ?? false;
    // 记下的是这个平台上实际给出的工具，界面和恢复看到的都和子 Agent 手里的一致。
    const tools = childToolsForPlatform(profile?.tools ?? DEFAULT_CHILD_TOOLS);
    const run: ChildRun = {
      runId: createRunId(),
      parentToolId: toolCallId,
      agent: profile?.name ?? (profileName || "default"),
      task,
      model: resolved.label,
      modelInherited,
      tools,
      background,
      status: "running",
      worktreeRequired: useWorktree,
      startedAt: Date.now(),
      recentTools: [],
      recentOutput: [],
      messages: [],
      toolCalls: [],
      timeline: [],
      toolCount: 0,
      turnCount: 0,
      tokens: 0,
      bashBuffer: "",
      planId: params.planId,
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
      modelInherited: run.modelInherited,
      tools: [...tools],
      background,
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile(),
      worktree: useWorktree,
      startedAt: run.startedAt,
      planId: run.planId,
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
        parentEvents: pi.events,
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
      const catalog = formatProfileCatalog(profiles, (item) => readConfiguredSubagentModel(item.name) || item.model);
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
    sessionContext = ctx;
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
      if (request.method === "run") {
        const task = request.params?.task?.trim() ?? "";
        if (!task) return replyError("缺少子 Agent 任务描述（task）。");
        if (!sessionContext) return replyError("父会话尚未完成初始化，暂时无法派发子 Agent。");
        const outcome = await executeRun(
          `plan-${request.params?.planId ?? request.requestId}`,
          {
            agent: request.params?.agent,
            task,
            // 默认阻塞，和 subagent 工具那条路径一致（那边是 params.background === true）。
            // 这里原本默认 true，同一个「派发子 Agent」在两条入口下行为相反：走工具是
            // 等它跑完，走 RPC 是立刻返回。派发的默认语义应当是等结果，要并行再显式
            // 传 background:true。
            background: request.params?.background ?? false,
            worktree: request.params?.worktree,
            planId: request.params?.planId,
          },
          undefined,
          undefined,
          sessionContext,
        );
        pi.events.emit(replyChannel, {
          version: 1,
          requestId: request.requestId,
          success: true,
          data: { details: outcome.details },
        });
        return;
      }
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
    sessionContext = undefined;
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Dispatch and manage subagents. A subagent runs in its own session and suits tasks that need a lot of context (searching, reading, code changes); only its summarized result comes back, so the main session's context is not used up.",
      "Delegate work that needs heavy file reading or searching, or any self-contained chunk, to a subagent; send several independent subtasks as multiple subagent calls in the same message so they run in parallel.",
      "The task you pass must be self-contained: give the background, the key paths and the expected output format, and do not assume the subagent can see the main session's context. Write the task in the user's language, because the report comes back in the language of the task.",
      "Pick the profile by role: explore for read-only reconnaissance, reviewer for code review, worker when code must be written; call action=status without a runId to list the available profiles.",
      "When you are not in a hurry for the result, or want to keep working meanwhile, dispatch with background:true; the subagent reports back by itself when it finishes, so there is no need to poll, and action=status shows progress when you want it.",
      "A finished subagent can continue in the same session with action=resume, which saves context compared with dispatching a new one.",
      "When several subagents write to the same repository in parallel, always use worktree:true (on by default for the worker profile) so each works on its own git worktree branch and they do not overwrite each other; the changes stay in the worktree for you to review and merge.",
    ].join(" "),
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
