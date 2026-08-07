import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createEventBus,
  createAgentSession,
  processImage,
  type AgentSession,
  type AgentSessionEvent,
  type EventBusController,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type {
  ChangedFile,
  ChangeStatus,
  ChatMessage,
  ContextUsage,
  FileNode,
  McpConfigurationSnapshot,
  McpImportConfiguration,
  McpServerConfiguration,
  ModelOption,
  PromptImage,
  ProjectSnapshot,
  RuntimeBootstrap,
  RuntimeConfiguration,
  RuntimeEvent,
  ResponseMetrics,
  SessionSnapshot,
  SessionSummary,
  SubagentActivity,
  TerminalRun,
  ThinkingLevel,
  TokenUsage,
  TodoItem,
  ToolRun,
} from "@suocode/runtime-protocol";
import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const MAX_CHANGE_FILES = 100;
const MAX_PATCH_CHARS = 16_000;
const MAX_TERMINAL_OUTPUT = 120_000;
const WORKFLOW_AUDIT_ENTRY_TYPE = "suocode-tool-purpose-audit";
const RESPONSE_METRICS_ENTRY_TYPE = "suocode-response-metrics";
const WORKFLOW_PURPOSE_REGISTRY = Symbol.for("suocode-workflow.tool-purpose-registry");
const WORKFLOW_PURPOSE_FIELDS = ["purpose", "_auditPurpose", "__auditPurpose"] as const;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".next",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "release",
  "target",
]);

type EventSink = (event: RuntimeEvent) => void;

interface McpAdapterConfigModule {
  ensureCompatibilityImports(imports: McpImportConfiguration["kind"][], overridePath?: string): { path: string; added: McpImportConfiguration["kind"][] };
  getMcpDiscoverySummary(overridePath?: string, cwd?: string): {
    imports: Array<{ kind: McpImportConfiguration["kind"]; path: string; serverCount: number }>;
  };
  getPiGlobalConfigPath(overridePath?: string): string;
  getProjectPiConfigPath(cwd?: string): string;
  getServerProvenance(overridePath?: string, cwd?: string): Map<string, { path: string; kind: "user" | "project" | "import" }>;
  loadMcpConfig(overridePath?: string, cwd?: string): {
    imports?: McpImportConfiguration["kind"][];
    mcpServers: Record<string, Record<string, unknown>>;
  };
  writeSharedServerEntry(path: string, serverName: string, entry: Record<string, unknown>): string;
}

interface PiSubagentsStatusModule {
  ASYNC_DIR: string;
  RESULTS_DIR: string;
  listAsyncRuns(asyncDirRoot: string, options?: {
    states?: string[];
    sessionId?: string;
    resultsDir?: string;
  }): Array<{
    id: string;
    state: "queued" | "running" | "complete" | "failed" | "paused" | "stopped";
    mode: "single" | "parallel" | "chain";
    startedAt: number;
    lastUpdate?: number;
    currentTool?: string;
    currentPath?: string;
    turnCount?: number;
    toolCount?: number;
    totalTokens?: { total?: number };
    error?: string;
    steps: Array<{
      index: number;
      agent: string;
      label?: string;
      status: "pending" | "running" | "complete" | "completed" | "failed" | "paused" | "stopped" | "detached";
      currentTool?: string;
      currentPath?: string;
      recentTools?: Array<{ tool: string; args: string; endMs?: number }>;
      recentOutput?: string[];
      turnCount?: number;
      toolCount?: number;
      durationMs?: number;
      tokens?: { total?: number };
      model?: string;
      error?: string;
    }>;
  }>;
}

let mcpAdapterConfigModule: Promise<McpAdapterConfigModule> | undefined;
let piSubagentsStatusModule: Promise<PiSubagentsStatusModule> | undefined;

function loadMcpAdapterConfigModule(): Promise<McpAdapterConfigModule> {
  const { createJiti } = require("jiti") as typeof import("jiti");
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  mcpAdapterConfigModule ??= jiti.import(join(resolvePackageDirectory("pi-mcp-adapter"), "config.ts")) as Promise<McpAdapterConfigModule>;
  return mcpAdapterConfigModule;
}

function loadPiSubagentsStatusModule(): Promise<PiSubagentsStatusModule> {
  const { createJiti } = require("jiti") as typeof import("jiti");
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const packageDirectory = resolvePackageDirectory("pi-subagents");
  piSubagentsStatusModule ??= Promise.all([
    jiti.import(join(packageDirectory, "src", "runs", "background", "async-status.ts")),
    jiti.import(join(packageDirectory, "src", "shared", "types.ts")),
  ]).then(([status, shared]) => ({
    ...(status as Pick<PiSubagentsStatusModule, "listAsyncRuns">),
    ...(shared as Pick<PiSubagentsStatusModule, "ASYNC_DIR" | "RESULTS_DIR">),
  }));
  return piSubagentsStatusModule;
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export interface SuoCodeRuntimeOptions {
  agentDir: string;
  sessionDir: string;
  workflowDir?: string;
  legacyAgentDir?: string;
  onEvent?: EventSink;
}

interface ActiveSession {
  cwd: string;
  session: AgentSession;
  unsubscribe: () => void;
  tools: Map<string, ToolRun>;
  subagents: Map<string, SubagentActivity>;
  terminals: Map<string, TerminalRun>;
  plan: TodoItem[];
  project: ProjectSnapshot;
  messageIds: WeakMap<object, string>;
  activeAssistantId?: string;
  activeAssistantOrder?: number;
  nextTimelineOrder: number;
  responseMetrics?: ResponseMetrics;
  responseMetricsHistory: ResponseMetrics[];
  eventBus: EventBusController;
}

interface WorkflowManifest {
  pi?: {
    extensions?: string[];
    skills?: string[];
    prompts?: string[];
  };
}

interface RuntimeResources {
  extensions: string[];
  skills: string[];
  prompts: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorDetail(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

function clampText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… output truncated …`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function purposeFromArgs(args: Record<string, unknown>): string | undefined {
  for (const field of WORKFLOW_PURPOSE_FIELDS) {
    const value = args[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const [field, value] of Object.entries(args)) {
    if (field.startsWith("__auditPurpose_") && typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function liveToolPurpose(toolCallId: string | undefined): string | undefined {
  if (!toolCallId) return undefined;
  const registry = (globalThis as Record<PropertyKey, unknown>)[WORKFLOW_PURPOSE_REGISTRY];
  if (!(registry instanceof Map)) return undefined;
  const record = registry.get(toolCallId);
  if (!isRecord(record)) return undefined;
  const purpose = stringValue(record.purpose).trim();
  return purpose || undefined;
}

function restoredToolPurposes(session: AgentSession): Map<string, string> {
  const purposes = new Map<string, string>();
  for (const entry of session.sessionManager.getEntries()) {
    if (
      entry.type !== "custom" ||
      entry.customType !== WORKFLOW_AUDIT_ENTRY_TYPE ||
      !isRecord(entry.data)
    ) {
      continue;
    }
    const toolCallId = stringValue(entry.data.toolCallId);
    const purpose = stringValue(entry.data.purpose).trim();
    if (toolCallId && purpose) purposes.set(toolCallId, purpose);
  }
  return purposes;
}

function responseMetricsFromData(data: unknown): ResponseMetrics | undefined {
  if (!isRecord(data)) return undefined;
  const outputTokens = Number(data.outputTokens);
  const totalMs = Number(data.totalMs);
  const turnDurationMs = Number(data.turnDurationMs);
  const timestamp = Number(data.timestamp);
  if (![outputTokens, totalMs, turnDurationMs, timestamp].every(Number.isFinite)) return undefined;
  const firstTokenMs = Number(data.firstTokenMs);
  const averageTokensPerSecond = Number(data.averageTokensPerSecond);
  const inputTokens = Number(data.inputTokens);
  const cacheReadTokens = Number(data.cacheReadTokens);
  const cacheWriteTokens = Number(data.cacheWriteTokens);
  return {
    firstTokenMs: Number.isFinite(firstTokenMs) ? firstTokenMs : undefined,
    averageTokensPerSecond: Number.isFinite(averageTokensPerSecond) ? averageTokensPerSecond : undefined,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : undefined,
    outputTokens,
    cacheReadTokens: Number.isFinite(cacheReadTokens) ? cacheReadTokens : undefined,
    cacheWriteTokens: Number.isFinite(cacheWriteTokens) ? cacheWriteTokens : undefined,
    totalMs,
    turnDurationMs,
    timestamp,
  };
}

function restoredResponseMetrics(session: AgentSession): ResponseMetrics[] {
  const metricsHistory: ResponseMetrics[] = [];
  for (const entry of session.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== RESPONSE_METRICS_ENTRY_TYPE) continue;
    const metrics = responseMetricsFromData(entry.data);
    if (metrics) metricsHistory.push(metrics);
  }
  return metricsHistory.sort((a, b) => a.timestamp - b.timestamp);
}

function sessionUsage(session: AgentSession): { contextUsage?: ContextUsage; tokenUsage: TokenUsage } {
  const stats = session.getSessionStats();
  return {
    contextUsage: stats.contextUsage,
    tokenUsage: { ...stats.tokens },
  };
}

function contentParts(content: unknown): { text: string; thinking: string; images: PromptImage[] } {
  if (typeof content === "string") return { text: content, thinking: "", images: [] };
  if (!Array.isArray(content)) return { text: "", thinking: "", images: [] };

  const text: string[] = [];
  const thinking: string[] = [];
  const images: PromptImage[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") text.push(block.text);
    if (block.type === "thinking" && typeof block.thinking === "string") thinking.push(block.thinking);
    if (block.type === "thinking" && typeof block.text === "string") thinking.push(block.text);
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      images.push({ mimeType: block.mimeType, data: block.data });
    }
  }
  return { text: text.join("\n"), thinking: thinking.join("\n"), images };
}

function toolResultText(result: unknown): string {
  if (!isRecord(result)) return stringValue(result);
  const direct = contentParts(result.content).text;
  if (direct) return direct;
  if (typeof result.output === "string") return result.output;
  if (typeof result.text === "string") return result.text;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function subagentStatus(value: unknown, fallback: SubagentActivity["status"] = "running"): SubagentActivity["status"] {
  if (value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "stopped" || value === "paused" || value === "detached") return value;
  if (value === "complete") return "completed";
  return fallback;
}

function subagentTokens(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!isRecord(value)) return 0;
  return typeof value.total === "number" && Number.isFinite(value.total) ? value.total : 0;
}

function subagentUsageTokens(value: unknown): number {
  if (!isRecord(value)) return 0;
  return [value.input, value.output, value.cacheRead, value.cacheWrite]
    .reduce<number>((total, item) => total + (typeof item === "number" && Number.isFinite(item) ? item : 0), 0);
}

function subagentRecentTools(value: unknown): Array<{ tool: string; args: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools = value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const tool = stringValue(entry.tool);
    if (!tool) return [];
    return [{ tool, args: stringValue(entry.args) }];
  });
  return tools.length ? tools : undefined;
}

function subagentRecentOutput(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output = value.flatMap((entry) => typeof entry === "string" && entry.trim() ? [clampText(entry, 12_000)] : []).slice(-24);
  return output.length ? output : undefined;
}

function subagentMessages(value: unknown): Array<{ role: string; text: string; thinking?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const messages = value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const parts = contentParts(entry.content);
    const text = parts.text || stringValue(entry.text);
    const thinking = parts.thinking || undefined;
    if (!text && !thinking) return [];
    return [{ role: stringValue(entry.role) || "unknown", text: clampText(text, 24_000), thinking: thinking ? clampText(thinking, 24_000) : undefined }];
  }).slice(-40);
  return messages.length ? messages : undefined;
}

function subagentToolCalls(value: unknown): Array<{ text: string; expandedText?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls = value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const text = stringValue(entry.text);
    const expandedText = stringValue(entry.expandedText) || undefined;
    if (!text && !expandedText) return [];
    return [{ text: clampText(text || expandedText || "工具调用", 2_000), expandedText: expandedText ? clampText(expandedText, 16_000) : undefined }];
  }).slice(-80);
  return calls.length ? calls : undefined;
}

function subagentActivitiesFromResult(result: unknown, fallbackRunId: string, background = false): SubagentActivity[] {
  if (!isRecord(result) || !isRecord(result.details)) return [];
  const details = result.details;
  const mode = details.mode === "parallel" || details.mode === "chain" ? details.mode : "single";
  const runId = stringValue(details.runId) || stringValue(details.asyncId) || fallbackRunId;
  const isBackground = background || Boolean(details.asyncId);
  const updatedAt = Date.now();
  const progress = Array.isArray(details.progress) ? details.progress : [];
  const results = Array.isArray(details.results) ? details.results : [];
  const progressByIndex = new Map<number, Record<string, unknown>>();
  progress.forEach((raw, position) => {
    if (!isRecord(raw)) return;
    progressByIndex.set(typeof raw.index === "number" ? raw.index : position, raw);
  });
  const resultByIndex = new Map<number, Record<string, unknown>>();
  results.forEach((raw, index) => { if (isRecord(raw)) resultByIndex.set(index, raw); });
  const indexes = [...new Set([...progressByIndex.keys(), ...resultByIndex.keys()])].sort((left, right) => left - right);
  return indexes.map((index) => {
    const progressItem = progressByIndex.get(index);
    const resultItem = resultByIndex.get(index);
    const failed = resultItem
      ? resultItem.stopped === true ? "stopped" : resultItem.detached === true ? "detached" : resultItem.exitCode === 0 ? "completed" : "failed"
      : subagentStatus(progressItem?.status);
    const usage = resultItem && isRecord(resultItem.usage) ? resultItem.usage : undefined;
    const progressSummary = resultItem && isRecord(resultItem.progressSummary) ? resultItem.progressSummary : undefined;
    return {
      id: `${runId}:${index}`,
      runId,
      parentToolId: fallbackRunId,
      index,
      agent: stringValue(resultItem?.agent) || stringValue(progressItem?.agent) || `代理 ${index + 1}`,
      task: stringValue(resultItem?.task) || stringValue(progressItem?.task) || undefined,
      model: stringValue(resultItem?.model) || stringValue(progressItem?.model) || undefined,
      mode,
      status: failed,
      background: isBackground,
      currentTool: stringValue(progressItem?.currentTool) || undefined,
      currentPath: stringValue(progressItem?.currentPath) || undefined,
      recentTools: subagentRecentTools(progressItem?.recentTools),
      recentOutput: subagentRecentOutput(progressItem?.recentOutput),
      messages: subagentMessages(resultItem?.messages),
      toolCalls: subagentToolCalls(resultItem?.toolCalls),
      finalOutput: stringValue(resultItem?.finalOutput) ? clampText(stringValue(resultItem?.finalOutput), 48_000) : undefined,
      transcriptPath: stringValue(resultItem?.transcriptPath) || undefined,
      sessionFile: stringValue(resultItem?.sessionFile) || undefined,
      toolCount: typeof progressSummary?.toolCount === "number" ? progressSummary.toolCount : Array.isArray(resultItem?.toolCalls) ? resultItem.toolCalls.length : typeof progressItem?.toolCount === "number" ? progressItem.toolCount : 0,
      turnCount: usage && typeof usage.turns === "number" ? usage.turns : typeof progressItem?.turnCount === "number" ? progressItem.turnCount : undefined,
      tokens: subagentUsageTokens(usage) || subagentTokens(progressSummary?.tokens) || subagentTokens(progressItem?.tokens),
      durationMs: typeof progressSummary?.durationMs === "number" ? progressSummary.durationMs : typeof progressItem?.durationMs === "number" ? progressItem.durationMs : 0,
      error: stringValue(resultItem?.error) || stringValue(progressItem?.error) || undefined,
      updatedAt,
    } satisfies SubagentActivity;
  });
}

function messageTimestamp(message: Record<string, unknown>): number {
  const timestamp = message.timestamp;
  if (typeof timestamp === "number") return timestamp;
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function mapMessage(message: unknown, id: string, order: number, entryId?: string): ChatMessage | undefined {
  if (!isRecord(message) || typeof message.role !== "string") return undefined;
  const role = message.role;
  const parts = contentParts(message.content);

  if (role === "user") {
    return { id, entryId, order, role: "user", text: parts.text, images: parts.images.length ? parts.images : undefined, timestamp: messageTimestamp(message) };
  }
  if (role === "assistant") {
    const stopReason = stringValue(message.stopReason);
    const failed = stopReason === "error" || stopReason === "aborted";
    return {
      id,
      order,
      role: "assistant",
      text: parts.text || (failed ? stringValue(message.errorMessage) : ""),
      thinking: parts.thinking || undefined,
      timestamp: messageTimestamp(message),
      isError: stopReason === "error",
      status: stopReason === "aborted" ? "aborted" : stopReason === "error" ? "failed" : "succeeded",
    };
  }
  if (role === "toolResult") {
    return {
      id,
      order,
      role: "tool",
      text: parts.text,
      timestamp: messageTimestamp(message),
      toolName: stringValue(message.toolName) || "tool",
      toolCallId: stringValue(message.toolCallId) || undefined,
      isError: message.isError === true,
      status: message.isError === true ? "failed" : "succeeded",
    };
  }
  if (role === "bashExecution") {
    return {
      id,
      order,
      role: "tool",
      text: stringValue(message.output),
      timestamp: messageTimestamp(message),
      toolName: "bash",
      status: "succeeded",
    };
  }
  if (role === "custom" && message.display !== false) {
    return { id, order, role: "system", text: parts.text, timestamp: messageTimestamp(message) };
  }
  return undefined;
}

function titleFromText(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "新建对话";
  return oneLine.length > 64 ? `${oneLine.slice(0, 61)}…` : oneLine;
}

async function preparePromptImages(images: PromptImage[] | undefined): Promise<{ images: PromptImage[]; hints: string }> {
  if (!images?.length) return { images: [], hints: "" };
  const prepared: PromptImage[] = [];
  const hints: string[] = [];
  for (const [index, image] of images.entries()) {
    if (!image.mimeType.startsWith("image/") || !image.data) throw new Error("粘贴的图片数据无效。");
    const processed = await processImage(Buffer.from(image.data, "base64"), image.mimeType, { autoResizeImages: true });
    if (!processed.ok) throw new Error(`第 ${index + 1} 张图片无法处理：${processed.message}`);
    prepared.push({ id: image.id, name: image.name, mimeType: processed.mimeType, data: processed.data });
    if (processed.hints.length) hints.push(`<image name="${image.name || `pasted-${index + 1}`}">${processed.hints.join("\n")}</image>`);
  }
  return { images: prepared, hints: hints.join("\n") };
}

function sessionSummary(info: SessionInfo): SessionSummary {
  return {
    id: info.id,
    path: info.path,
    cwd: info.cwd,
    title: info.name || titleFromText(info.firstMessage),
    createdAt: info.created.toISOString(),
    updatedAt: info.modified.toISOString(),
    messageCount: info.messageCount,
  };
}

function normalizeTodoPlan(value: unknown): TodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: TodoItem[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const rawText = typeof item.text === "string" ? item.text : typeof item.step === "string" ? item.step : undefined;
    const status = item.status;
    if (!rawText || (status !== "pending" && status !== "in_progress" && status !== "completed")) {
      return undefined;
    }
    result.push({ text: rawText, status });
  }
  return result;
}

function planFromResult(result: unknown): TodoItem[] | undefined {
  if (!isRecord(result)) return undefined;
  const details = isRecord(result.details) ? result.details : undefined;
  return normalizeTodoPlan(details?.plan);
}

function extractExitCode(result: unknown): number | undefined {
  if (!isRecord(result)) return undefined;
  const details = isRecord(result.details) ? result.details : undefined;
  const candidates = [details?.exitCode, details?.code, result.exitCode];
  return candidates.find((value): value is number => typeof value === "number");
}

function statusFromPorcelain(code: string): ChangeStatus {
  if (code === "??") return "untracked";
  if (code.includes("U") || code === "AA" || code === "DD") return "conflicted";
  if (code.includes("R")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "modified";
}

function safeRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function ensureInside(root: string, path: string): string {
  const resolvedRoot = safeRealPath(root);
  const candidate = isAbsolute(path) ? resolve(path) : resolve(resolvedRoot, path);
  const target = existsSync(candidate) ? safeRealPath(candidate) : candidate;
  const rel = relative(resolvedRoot, target);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("请求的文件不在当前项目中。");
  }
  return target;
}

async function directoryNodes(cwd: string, requestedPath = ""): Promise<FileNode[]> {
  const directory = requestedPath ? ensureInside(cwd, requestedPath) : safeRealPath(cwd);
  const directoryStat = await stat(directory);
  if (!directoryStat.isDirectory()) throw new Error("所选路径不是文件夹。");
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return entries.flatMap((entry): FileNode[] => {
    if ((entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) || entry.name === ".DS_Store") return [];
    const absolute = join(directory, entry.name);
    const path = relative(cwd, absolute) || entry.name;
    if (entry.isDirectory()) return [{ name: entry.name, path, kind: "directory" }];
    if (entry.isFile() || entry.isSymbolicLink()) return [{ name: entry.name, path, kind: "file" }];
    return [];
  });
}

async function gitChanges(cwd: string): Promise<ChangedFile[]> {
  let statusOutput = "";
  try {
    const result = await execFileAsync("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all"], {
      maxBuffer: 4 * 1024 * 1024,
    });
    statusOutput = result.stdout;
  } catch {
    return [];
  }

  const records = statusOutput
    .split("\n")
    .filter(Boolean)
    .slice(0, MAX_CHANGE_FILES)
    .map((line) => {
      const code = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) || rawPath : rawPath;
      return { code, path: path.replace(/^"|"$/g, "") };
    });

  const numstat = new Map<string, { additions: number; deletions: number }>();
  try {
    const result = await execFileAsync("git", ["-C", cwd, "diff", "--numstat", "HEAD", "--", "."], {
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const line of result.stdout.split("\n")) {
      const [added, deleted, ...pathParts] = line.split("\t");
      const path = pathParts.join("\t");
      if (!path) continue;
      numstat.set(path, {
        additions: added === "-" ? 0 : Number.parseInt(added || "0", 10) || 0,
        deletions: deleted === "-" ? 0 : Number.parseInt(deleted || "0", 10) || 0,
      });
    }
  } catch {
    // A repository without HEAD can still expose status and untracked files.
  }

  return Promise.all(
    records.map(async ({ code, path }) => {
      const stats = numstat.get(path) ?? { additions: 0, deletions: 0 };
      const status = statusFromPorcelain(code);
      let patch: string | undefined;
      if (status === "untracked") {
        try {
          const target = ensureInside(cwd, path);
          const fileStat = await stat(target);
          if (fileStat.isFile() && fileStat.size <= 256 * 1024) {
            const source = await readFile(target, "utf8");
            const lines = source.split("\n");
            stats.additions = lines.length;
            patch = clampText(
              [`diff --git a/${path} b/${path}`, "new file", "--- /dev/null", `+++ b/${path}`, ...lines.map((line) => `+${line}`)].join("\n"),
              MAX_PATCH_CHARS,
            );
          }
        } catch {
          // Binary, unreadable, or concurrently removed files remain listed without a patch.
        }
      } else {
        try {
          const result = await execFileAsync("git", ["-C", cwd, "diff", "--no-ext-diff", "--unified=3", "HEAD", "--", path], {
            maxBuffer: 2 * 1024 * 1024,
          });
          patch = clampText(result.stdout, MAX_PATCH_CHARS) || undefined;
        } catch {
          patch = undefined;
        }
      }
      return { path, status, ...stats, patch } satisfies ChangedFile;
    }),
  );
}

function resolveWorkflowDirectory(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const manifestPath = require.resolve("@suocode/workflow/package.json");
  return dirname(manifestPath);
}

function resourcesFromManifest(directory: string): RuntimeResources {
  const manifestPath = join(directory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WorkflowManifest;
  return {
    extensions: (manifest.pi?.extensions ?? []).map((path) => resolve(directory, path)),
    skills: (manifest.pi?.skills ?? []).map((path) => resolve(directory, path)),
    prompts: (manifest.pi?.prompts ?? []).map((path) => resolve(directory, path)),
  };
}

function resolvePackageDirectory(packageName: string): string {
  try {
    return dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    let entryPath: string;
    try {
      entryPath = require.resolve(packageName);
    } catch {
      entryPath = fileURLToPath(import.meta.resolve(packageName));
    }
    let directory = dirname(entryPath);
    while (directory !== dirname(directory)) {
      const manifestPath = join(directory, "package.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string };
        if (manifest.name === packageName) return directory;
      }
      directory = dirname(directory);
    }
  }
  throw new Error(`Unable to resolve bundled package: ${packageName}`);
}

function bundledRuntimeResources(workflowDirectory: string): RuntimeResources {
  const packageDirectories = [
    workflowDirectory,
    resolvePackageDirectory("pi-mcp-adapter"),
    resolvePackageDirectory("pi-subagents"),
  ];
  const resources = packageDirectories.map(resourcesFromManifest);
  return {
    extensions: resources.flatMap((entry) => entry.extensions),
    skills: resources.flatMap((entry) => entry.skills),
    prompts: resources.flatMap((entry) => entry.prompts),
  };
}

function seedLegacyConfiguration(agentDir: string, legacyAgentDir: string): boolean {
  mkdirSync(agentDir, { recursive: true });
  let migrated = false;
  const authPath = join(agentDir, "auth.json");
  const legacyAuthPath = join(legacyAgentDir, "auth.json");
  if (!existsSync(authPath) && existsSync(legacyAuthPath)) {
    copyFileSync(legacyAuthPath, authPath);
    try {
      const mode = statSync(legacyAuthPath).mode & 0o777;
      chmodSync(authPath, mode || 0o600);
    } catch {
      // The copied credential remains usable even when permissions cannot be mirrored.
    }
    migrated = true;
  }

  const modelsPath = join(agentDir, "models.json");
  const legacyModelsPath = join(legacyAgentDir, "models.json");
  if (!existsSync(modelsPath) && existsSync(legacyModelsPath)) {
    copyFileSync(legacyModelsPath, modelsPath);
  }

  const settingsPath = join(agentDir, "settings.json");
  const legacySettingsPath = join(legacyAgentDir, "settings.json");
  if (!existsSync(settingsPath) && existsSync(legacySettingsPath)) {
    try {
      const legacy = JSON.parse(readFileSync(legacySettingsPath, "utf8")) as Record<string, unknown>;
      const selected = Object.fromEntries(
        ["defaultProvider", "defaultModel", "defaultThinkingLevel", "transport"].flatMap((key) =>
          legacy[key] === undefined ? [] : [[key, legacy[key]]],
        ),
      );
      writeFileSync(settingsPath, `${JSON.stringify(selected, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // Invalid legacy settings are intentionally ignored instead of copied wholesale.
    }
  }
  return migrated;
}

export class SuoCodeRuntime {
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly workflowDir: string;

  private readonly emitEvent: EventSink;
  private readonly extensionPaths: string[];
  private readonly skillPaths: string[];
  private readonly promptPaths: string[];
  private modelRuntime?: ModelRuntime;
  private active?: ActiveSession;
  private initialized = false;
  private migratedLegacyCredentials = false;
  private projectRefreshTimer?: ReturnType<typeof setTimeout>;
  private subagentRefreshTimer?: ReturnType<typeof setTimeout>;
  private mcpReloadTimer?: ReturnType<typeof setTimeout>;

  constructor(options: SuoCodeRuntimeOptions) {
    this.agentDir = resolve(options.agentDir);
    this.sessionDir = resolve(options.sessionDir);
    this.workflowDir = resolveWorkflowDirectory(options.workflowDir);
    const resources = bundledRuntimeResources(this.workflowDir);
    this.extensionPaths = resources.extensions;
    this.skillPaths = resources.skills;
    this.promptPaths = resources.prompts;
    this.emitEvent = options.onEvent ?? (() => undefined);
    const codingAgentRoot = resolvePackageDirectory("@earendil-works/pi-coding-agent");
    process.env.PI_CODING_AGENT_DIR = this.agentDir;
    process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = codingAgentRoot;
    process.env.PI_MEMORY_WORKER_ENTRY = join(codingAgentRoot, "dist", "cli.js");
    this.migratedLegacyCredentials = options.legacyAgentDir
      ? seedLegacyConfiguration(this.agentDir, resolve(options.legacyAgentDir))
      : false;
    mkdirSync(this.sessionDir, { recursive: true });
  }

  async initialize(): Promise<RuntimeBootstrap> {
    if (!this.initialized) {
      this.modelRuntime = await ModelRuntime.create({
        authPath: join(this.agentDir, "auth.json"),
        modelsPath: join(this.agentDir, "models.json"),
        allowModelNetwork: false,
      });
      this.initialized = true;
    }
    const configuration = await this.getConfiguration();
    this.emitEvent({ type: "runtime_ready", configuration });
    return { configuration, activeSession: this.active ? await this.snapshot() : undefined };
  }

  private async ready(): Promise<ModelRuntime> {
    if (!this.initialized) await this.initialize();
    if (!this.modelRuntime) throw new Error("SuoCode runtime failed to initialize.");
    return this.modelRuntime;
  }

  async getConfiguration(): Promise<RuntimeConfiguration> {
    const modelRuntime = await this.ready();
    const cwd = this.active?.cwd ?? process.cwd();
    const settings = SettingsManager.create(cwd, this.agentDir);
    const providers = new Map(modelRuntime.getProviders().map((provider) => [provider.id, provider.name || provider.id]));
    const configuredProviders = modelRuntime
      .getProviders()
      .filter((provider) => modelRuntime.hasConfiguredAuth(provider.id))
      .map((provider) => provider.id)
      .sort();
    const configuredSet = new Set(configuredProviders);
    const models: ModelOption[] = modelRuntime
      .getModels()
      .map((model) => ({
        provider: model.provider,
        providerName: providers.get(model.provider) ?? model.provider,
        id: model.id,
        name: model.name || model.id,
        reasoning: Boolean(model.reasoning),
        supportsImages: model.input.includes("image"),
        supportedThinkingLevels: getSupportedThinkingLevels(model) as ThinkingLevel[],
        contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
        configured: configuredSet.has(model.provider),
      }))
      .sort((a, b) => {
        if (a.configured !== b.configured) return a.configured ? -1 : 1;
        const providerOrder = a.providerName.localeCompare(b.providerName);
        return providerOrder || a.name.localeCompare(b.name, undefined, { numeric: true });
      });

    return {
      provider: settings.getDefaultProvider(),
      modelId: settings.getDefaultModel(),
      thinkingLevel: (settings.getDefaultThinkingLevel() ?? "medium") as ThinkingLevel,
      configuredProviders,
      models,
      migratedLegacyCredentials: this.migratedLegacyCredentials,
    };
  }

  async configureModel(input: {
    provider: string;
    modelId: string;
    thinkingLevel: ThinkingLevel;
    apiKey?: string;
  }): Promise<RuntimeConfiguration> {
    const modelRuntime = await this.ready();
    const model = modelRuntime.getModel(input.provider, input.modelId);
    if (!model) throw new Error(`Unknown model: ${input.provider}/${input.modelId}`);

    if (input.apiKey?.trim()) {
      const key = input.apiKey.trim();
      await modelRuntime.login(input.provider, "api_key", {
        prompt: async () => key,
        notify: () => undefined,
      });
    }
    if (!(await modelRuntime.checkAuth(input.provider))) {
      throw new Error(`No credential is configured for ${input.provider}.`);
    }

    const effectiveThinkingLevel = clampThinkingLevel(model, input.thinkingLevel) as ThinkingLevel;
    const settings = this.active?.session.settingsManager ?? SettingsManager.create(this.active?.cwd ?? process.cwd(), this.agentDir);
    settings.setDefaultModelAndProvider(input.provider, input.modelId);
    settings.setDefaultThinkingLevel(effectiveThinkingLevel);
    await settings.flush();

    if (this.active) {
      await this.active.session.setModel(model);
      this.active.session.setThinkingLevel(effectiveThinkingLevel);
      this.emitEvent({ type: "session_snapshot", snapshot: await this.snapshot() });
    }

    const configuration = await this.getConfiguration();
    this.emitEvent({ type: "configuration_updated", configuration });
    return configuration;
  }

  async removeProviderAuth(provider: string): Promise<RuntimeConfiguration> {
    const modelRuntime = await this.ready();
    await modelRuntime.logout(provider);
    const configuration = await this.getConfiguration();
    this.emitEvent({ type: "configuration_updated", configuration });
    return configuration;
  }

  private mcpCwd(cwd?: string): string {
    return cwd ? safeRealPath(cwd) : this.active?.cwd ?? process.cwd();
  }

  private archivedSessionsPath(): string {
    return join(this.agentDir, "archived-sessions.json");
  }

  private readArchivedSessions(): Record<string, string> {
    const path = this.archivedSessionsPath();
    if (!existsSync(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return recordOfStrings(parsed);
    } catch {
      return {};
    }
  }

  private writeArchivedSessions(value: Record<string, string>): void {
    mkdirSync(this.agentDir, { recursive: true });
    const path = this.archivedSessionsPath();
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  }

  private reloadMcpExtension(): void {
    if (this.mcpReloadTimer) clearTimeout(this.mcpReloadTimer);
    this.mcpReloadTimer = setTimeout(() => {
      this.mcpReloadTimer = undefined;
      if (!this.active || this.active.session.isStreaming) return;
      const active = this.active;
      void active.session.reload()
        .then(async () => {
          if (this.active !== active) return;
          this.emitEvent({ type: "session_snapshot", snapshot: await this.snapshot() });
        })
        .catch((error) => {
          this.emitEvent({ type: "runtime_error", message: `MCP 扩展重新加载失败：${errorMessage(error)}`, detail: errorDetail(error) });
        });
    }, 750);
  }

  async getMcpConfiguration(cwd?: string): Promise<McpConfigurationSnapshot> {
    const adapter = await loadMcpAdapterConfigModule();
    const configPath = adapter.getPiGlobalConfigPath(join(this.agentDir, "mcp.json"));
    const resolvedCwd = this.mcpCwd(cwd);
    const projectConfigPath = cwd ? adapter.getProjectPiConfigPath(resolvedCwd) : undefined;
    const config = adapter.loadMcpConfig(configPath, resolvedCwd);
    const discovery = adapter.getMcpDiscoverySummary(configPath, resolvedCwd);
    const provenance = adapter.getServerProvenance(configPath, resolvedCwd);
    const enabledImports = new Set(config.imports ?? []);
    return {
      configPath,
      projectConfigPath,
      imports: discovery.imports.map((entry) => ({ ...entry, enabled: enabledImports.has(entry.kind) })),
      servers: Object.entries(config.mcpServers).map(([name, raw]) => {
        const source = provenance.get(name);
        return {
          name,
          scope: source?.kind === "project" ? "project" : "global",
          transport: typeof raw.url === "string" ? "http" : "stdio",
          command: typeof raw.command === "string" ? raw.command : undefined,
          args: stringArray(raw.args),
          env: recordOfStrings(raw.env),
          cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
          url: typeof raw.url === "string" ? raw.url : undefined,
          headers: recordOfStrings(raw.headers),
          auth: raw.auth === "oauth" || raw.auth === "bearer" || raw.auth === false ? raw.auth : undefined,
          bearerTokenEnv: typeof raw.bearerTokenEnv === "string" ? raw.bearerTokenEnv : undefined,
          lifecycle: raw.lifecycle === "keep-alive" || raw.lifecycle === "eager" ? raw.lifecycle : "lazy",
          idleTimeout: typeof raw.idleTimeout === "number" ? raw.idleTimeout : undefined,
          requestTimeoutMs: typeof raw.requestTimeoutMs === "number" ? raw.requestTimeoutMs : undefined,
          exposeResources: raw.exposeResources !== false,
          directTools: raw.directTools === true ? true : stringArray(raw.directTools),
          excludeTools: stringArray(raw.excludeTools),
          debug: raw.debug === true,
          source: source?.path,
          sourceKind: source?.kind,
        } satisfies McpServerConfiguration;
      }).sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  async saveMcpServer(server: McpServerConfiguration, previousName?: string, cwd?: string): Promise<McpConfigurationSnapshot> {
    const name = server.name.trim();
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("MCP 名称只能包含字母、数字、点、下划线和连字符。");
    if (server.transport === "stdio" && !server.command?.trim()) throw new Error("stdio MCP 需要填写启动命令。");
    if (server.transport === "http" && !server.url?.trim()) throw new Error("HTTP MCP 需要填写服务器地址。");
    if (server.scope === "project" && !cwd) throw new Error("项目级 MCP 需要当前工作区。");
    if (server.idleTimeout !== undefined && (!Number.isFinite(server.idleTimeout) || server.idleTimeout < 0)) throw new Error("空闲超时必须是大于等于 0 的分钟数。");
    if (server.requestTimeoutMs !== undefined && (!Number.isFinite(server.requestTimeoutMs) || server.requestTimeoutMs < 0)) throw new Error("请求超时必须是大于等于 0 的毫秒数。");
    const adapter = await loadMcpAdapterConfigModule();
    const globalConfigPath = adapter.getPiGlobalConfigPath(join(this.agentDir, "mcp.json"));
    const resolvedCwd = this.mcpCwd(cwd);
    const configPath = server.scope === "project" ? adapter.getProjectPiConfigPath(resolvedCwd) : globalConfigPath;
    if (previousName) {
      const previous = (await this.getMcpConfiguration(cwd)).servers.find((item) => item.name === previousName);
      const previousPath = previous?.scope === "project" ? adapter.getProjectPiConfigPath(resolvedCwd) : globalConfigPath;
      if (previousName !== name || previousPath !== configPath) this.removeMcpServerFromFile(previousPath, previousName);
    }
    const definition: Record<string, unknown> = server.transport === "http"
      ? { url: server.url?.trim(), ...(Object.keys(server.headers).length ? { headers: server.headers } : {}), ...(server.auth !== undefined ? { auth: server.auth } : {}) }
      : { command: server.command?.trim(), ...(server.args.length ? { args: server.args } : {}), ...(Object.keys(server.env).length ? { env: server.env } : {}), ...(server.cwd?.trim() ? { cwd: server.cwd.trim() } : {}) };
    definition.lifecycle = server.lifecycle;
    if (server.bearerTokenEnv?.trim()) definition.bearerTokenEnv = server.bearerTokenEnv.trim();
    if (server.idleTimeout !== undefined) definition.idleTimeout = server.idleTimeout;
    if (server.requestTimeoutMs !== undefined) definition.requestTimeoutMs = server.requestTimeoutMs;
    if (!server.exposeResources) definition.exposeResources = false;
    if (server.directTools === true || (Array.isArray(server.directTools) && server.directTools.length)) definition.directTools = server.directTools;
    if (server.excludeTools.length) definition.excludeTools = server.excludeTools;
    if (server.debug) definition.debug = true;
    adapter.writeSharedServerEntry(configPath, name, definition);
    this.reloadMcpExtension();
    return this.getMcpConfiguration(cwd);
  }

  private removeMcpServerFromFile(configPath: string, name: string): void {
    if (!existsSync(configPath)) return;
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers) || !(name in servers)) return;
    delete (servers as Record<string, unknown>)[name];
    const temporaryPath = `${configPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, configPath);
  }

  async removeMcpServer(name: string, scope: "global" | "project" = "global", cwd?: string): Promise<McpConfigurationSnapshot> {
    const adapter = await loadMcpAdapterConfigModule();
    if (scope === "project" && !cwd) throw new Error("项目级 MCP 需要当前工作区。");
    const configPath = scope === "project"
      ? adapter.getProjectPiConfigPath(this.mcpCwd(cwd))
      : adapter.getPiGlobalConfigPath(join(this.agentDir, "mcp.json"));
    this.removeMcpServerFromFile(configPath, name);
    this.reloadMcpExtension();
    return this.getMcpConfiguration(cwd);
  }

  async enableMcpImports(imports: McpImportConfiguration["kind"][], cwd?: string): Promise<McpConfigurationSnapshot> {
    const adapter = await loadMcpAdapterConfigModule();
    adapter.ensureCompatibilityImports(imports, join(this.agentDir, "mcp.json"));
    this.reloadMcpExtension();
    return this.getMcpConfiguration(cwd);
  }

  async listSessions(cwd: string): Promise<SessionSummary[]> {
    await this.ready();
    const resolvedCwd = safeRealPath(cwd);
    const sessions = await SessionManager.list(resolvedCwd, this.sessionDir);
    const archived = this.readArchivedSessions();
    const mapped = sessions.filter((session) => !archived[safeRealPath(session.path)]).map(sessionSummary);
    this.emitEvent({ type: "sessions_updated", cwd: resolvedCwd, sessions: mapped });
    return mapped;
  }

  async listArchivedSessions(cwd: string): Promise<SessionSummary[]> {
    await this.ready();
    const resolvedCwd = safeRealPath(cwd);
    const archived = this.readArchivedSessions();
    return (await SessionManager.list(resolvedCwd, this.sessionDir)).flatMap((session) => {
      const archivedAt = archived[safeRealPath(session.path)];
      return archivedAt ? [{ ...sessionSummary(session), archivedAt }] : [];
    });
  }

  async archiveSession(cwd: string, sessionPath: string): Promise<SessionSummary[]> {
    const resolvedCwd = safeRealPath(cwd);
    const resolvedSession = ensureInside(this.sessionDir, sessionPath);
    const belongsToProject = (await SessionManager.list(resolvedCwd, this.sessionDir))
      .some((session) => safeRealPath(session.path) === safeRealPath(resolvedSession));
    if (!belongsToProject) throw new Error("所选会话不属于当前工作区。");
    const archived = this.readArchivedSessions();
    archived[safeRealPath(resolvedSession)] = new Date().toISOString();
    this.writeArchivedSessions(archived);
    return this.listSessions(resolvedCwd);
  }

  async restoreSession(cwd: string, sessionPath: string): Promise<SessionSummary[]> {
    const resolvedCwd = safeRealPath(cwd);
    const resolvedSession = ensureInside(this.sessionDir, sessionPath);
    const archived = this.readArchivedSessions();
    delete archived[safeRealPath(resolvedSession)];
    this.writeArchivedSessions(archived);
    return this.listSessions(resolvedCwd);
  }

  async createSession(cwd: string): Promise<SessionSnapshot> {
    const resolvedCwd = safeRealPath(cwd);
    if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
      throw new Error(`Project directory does not exist: ${resolvedCwd}`);
    }
    return this.installSession(resolvedCwd, SessionManager.create(resolvedCwd, this.sessionDir));
  }

  async openSession(cwd: string, sessionPath: string): Promise<SessionSnapshot> {
    const resolvedCwd = safeRealPath(cwd);
    const resolvedSession = ensureInside(this.sessionDir, sessionPath);
    if (!existsSync(resolvedSession)) throw new Error("所选会话已不存在。");
    return this.installSession(resolvedCwd, SessionManager.open(resolvedSession, this.sessionDir, resolvedCwd));
  }

  private async installSession(cwd: string, sessionManager: SessionManager): Promise<SessionSnapshot> {
    const modelRuntime = await this.ready();
    if (this.projectRefreshTimer) clearTimeout(this.projectRefreshTimer);
    if (this.subagentRefreshTimer) clearTimeout(this.subagentRefreshTimer);
    if (this.active) {
      this.active.unsubscribe();
      this.active.session.dispose();
      this.active.eventBus.clear();
      this.active = undefined;
    }

    const settingsManager = SettingsManager.create(cwd, this.agentDir, { projectTrusted: true });
    const eventBus = createEventBus();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      settingsManager,
      eventBus,
      additionalExtensionPaths: this.extensionPaths,
      additionalSkillPaths: this.skillPaths,
      additionalPromptTemplatePaths: this.promptPaths,
      noExtensions: true,
      noThemes: true,
    });
    await loader.reload();
    const extensionErrors = loader.getExtensions().errors;
    if (extensionErrors.length > 0) {
      const message = extensionErrors.map((entry) => `${entry.path}: ${entry.error}`).join("\n");
      throw new Error(`SuoCode workflow failed to load:\n${message}`);
    }

    const created = await createAgentSession({
      cwd,
      agentDir: this.agentDir,
      modelRuntime,
      settingsManager,
      sessionManager,
      resourceLoader: loader,
    });
    await created.session.bindExtensions({});
    created.session.setActiveToolsByName(created.session.getActiveToolNames().filter((name) => name !== "find"));
    const activeToolNames = new Set(created.session.getActiveToolNames());
    const requiredTools = ["read", "bash", "edit", "write", "grep", "ls", "todo", "terminal", "mcp", "subagent"];
    const missingTools = requiredTools.filter((name) => !activeToolNames.has(name));
    if (missingTools.length > 0) {
      created.session.dispose();
      throw new Error(`SuoCode workflow did not activate required tools: ${missingTools.join(", ")}`);
    }

    const reconstructed = this.reconstructState(created.session);
    const project: ProjectSnapshot = {
      cwd,
      files: [],
      changes: [],
      terminals: [...reconstructed.terminals.values()],
      plan: reconstructed.plan,
      refreshedAt: Date.now(),
    };
    const active: ActiveSession = {
      cwd,
      session: created.session,
      unsubscribe: () => undefined,
      tools: reconstructed.tools,
      subagents: reconstructed.subagents,
      terminals: reconstructed.terminals,
      plan: reconstructed.plan,
      project,
      messageIds: new WeakMap(),
      nextTimelineOrder: reconstructed.nextTimelineOrder,
      responseMetrics: reconstructed.responseMetrics,
      responseMetricsHistory: reconstructed.responseMetricsHistory,
      eventBus,
    };
    this.active = active;
    active.unsubscribe = created.session.subscribe((event) => this.handleSessionEvent(event));
    await this.refreshAsyncSubagents();
    await this.refreshProject();
    const snapshot = await this.snapshot();
    this.emitEvent({ type: "session_snapshot", snapshot });
    await this.listSessions(cwd);
    return snapshot;
  }

  private reconstructState(session: AgentSession): {
    messages: ChatMessage[];
    tools: Map<string, ToolRun>;
    subagents: Map<string, SubagentActivity>;
    terminals: Map<string, TerminalRun>;
    plan: TodoItem[];
    nextTimelineOrder: number;
    responseMetrics?: ResponseMetrics;
    responseMetricsHistory: ResponseMetrics[];
  } {
    const messages: ChatMessage[] = [];
    const tools = new Map<string, ToolRun>();
    const subagents = new Map<string, SubagentActivity>();
    const terminals = new Map<string, TerminalRun>();
    let plan: TodoItem[] = [];
    const calls = new Map<string, { name: string; args: Record<string, unknown>; timestamp: number }>();
    const purposes = restoredToolPurposes(session);
    let order = 0;

    const branchMessages = session.sessionManager.getBranch().filter((entry) => entry.type === "message");
    for (const [index, entry] of branchMessages.entries()) {
      const rawMessage = entry.message;
      if (!isRecord(rawMessage)) continue;
      const mapped = mapMessage(rawMessage, `history-${entry.id}`, order, entry.id);
      if (mapped && mapped.role !== "tool" && (mapped.role === "user" || mapped.text || mapped.thinking)) {
        messages.push(mapped);
        order += 1;
      }
      if (rawMessage.role === "assistant" && Array.isArray(rawMessage.content)) {
        for (const block of rawMessage.content) {
          if (!isRecord(block) || block.type !== "toolCall") continue;
          const id = stringValue(block.id) || stringValue(block.toolCallId);
          const name = stringValue(block.name) || stringValue(block.toolName);
          const args = isRecord(block.arguments) ? block.arguments : isRecord(block.args) ? block.args : {};
          if (id && name) calls.set(id, { name, args, timestamp: messageTimestamp(rawMessage) });
        }
      }
      if (rawMessage.role !== "toolResult") continue;
      const id = stringValue(rawMessage.toolCallId) || `tool-${tools.size + 1}`;
      const name = stringValue(rawMessage.toolName) || calls.get(id)?.name || "tool";
      const args = calls.get(id)?.args ?? {};
      const output = clampText(contentParts(rawMessage.content).text, MAX_TERMINAL_OUTPUT);
      const failed = rawMessage.isError === true;
      tools.set(id, {
        id,
        order: order++,
        name,
        label: this.toolLabel(name, args, id, purposes.get(id)),
        args,
        output,
        status: failed ? "failed" : "succeeded",
        startedAt: calls.get(id)?.timestamp ?? messageTimestamp(rawMessage),
        endedAt: messageTimestamp(rawMessage),
      });
      const restoredPlan = normalizeTodoPlan(isRecord(rawMessage.details) ? rawMessage.details.plan : undefined);
      if (name === "todo" && restoredPlan) plan = restoredPlan;
      if (name === "subagent") {
        for (const activity of subagentActivitiesFromResult(rawMessage, id)) subagents.set(activity.id, activity);
      }
      if (name === "bash" || (name === "terminal" && args.action === "start")) {
        terminals.set(id, {
          id,
          command: stringValue(args.command) || name,
          cwd: stringValue(args.cwd) || this.active?.cwd || session.sessionManager.getCwd(),
          output,
          status: failed ? "failed" : "succeeded",
          startedAt: calls.get(id)?.timestamp ?? messageTimestamp(rawMessage),
          endedAt: messageTimestamp(rawMessage),
          exitCode: extractExitCode(rawMessage.details),
        });
      }
    }
    const responseMetricsHistory = restoredResponseMetrics(session);
    return {
      messages,
      tools,
      subagents,
      terminals,
      plan,
      nextTimelineOrder: order,
      responseMetrics: responseMetricsHistory.at(-1),
      responseMetricsHistory,
    };
  }

  private toolLabel(
    name: string,
    args: Record<string, unknown>,
    toolCallId?: string,
    restoredPurpose?: string,
  ): string {
    const purpose = restoredPurpose ?? liveToolPurpose(toolCallId) ?? purposeFromArgs(args);
    if (purpose) return purpose;
    if (name === "bash") return `运行 ${stringValue(args.command) || "命令"}`;
    if (name === "read") return `查看 ${stringValue(args.path) || "文件"}`;
    if (name === "write") return `写入 ${stringValue(args.path) || "文件"}`;
    if (name === "edit") return `编辑 ${stringValue(args.path) || "文件"}`;
    if (name === "grep") return `搜索 ${stringValue(args.pattern) || "项目"}`;
    if (name === "ls") return `查看 ${stringValue(args.path) || "目录"}`;
    if (name === "todo") return "更新 Todo";
    if (name === "terminal") return `运行 ${stringValue(args.command) || stringValue(args.action) || "终端命令"}`;
    return `调用 ${name.replace(/[_-]+/g, " ")}`;
  }

  private messageId(message: unknown, prefix: string): string {
    const active = this.active;
    if (!active || !isRecord(message)) return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const existing = active.messageIds.get(message);
    if (existing) return existing;
    const id = `${prefix}-${messageTimestamp(message)}-${Math.random().toString(36).slice(2, 8)}`;
    active.messageIds.set(message, id);
    return id;
  }

  private publishSubagents(): void {
    const active = this.active;
    if (!active) return;
    this.emitEvent({
      type: "subagents_updated",
      subagents: [...active.subagents.values()].sort((left, right) => left.updatedAt - right.updatedAt || left.index - right.index),
    });
  }

  private mergeSubagentActivities(activities: SubagentActivity[]): void {
    const active = this.active;
    if (!active || activities.length === 0) return;
    for (const activity of activities) {
      const existing = active.subagents.get(activity.id);
      active.subagents.set(activity.id, existing ? {
        ...existing,
        ...activity,
        task: activity.task ?? existing.task,
        currentTool: activity.currentTool ?? existing.currentTool,
        currentPath: activity.currentPath ?? existing.currentPath,
        model: activity.model ?? existing.model,
        recentTools: activity.recentTools ?? existing.recentTools,
        recentOutput: activity.recentOutput ?? existing.recentOutput,
        messages: activity.messages ?? existing.messages,
        toolCalls: activity.toolCalls ?? existing.toolCalls,
        finalOutput: activity.finalOutput ?? existing.finalOutput,
        transcriptPath: activity.transcriptPath ?? existing.transcriptPath,
        sessionFile: activity.sessionFile ?? existing.sessionFile,
        parentToolId: activity.parentToolId ?? existing.parentToolId,
        turnCount: activity.turnCount ?? existing.turnCount,
        error: activity.error ?? existing.error,
      } : activity);
    }
    this.publishSubagents();
  }

  private async refreshAsyncSubagents(): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (this.subagentRefreshTimer) clearTimeout(this.subagentRefreshTimer);
    try {
      const statusModule = await loadPiSubagentsStatusModule();
      if (active !== this.active) return;
      const runs = statusModule.listAsyncRuns(statusModule.ASYNC_DIR, {
        sessionId: active.session.sessionId,
        resultsDir: statusModule.RESULTS_DIR,
      });
      const updatedAt = Date.now();
      const activities = runs.flatMap((run) => run.steps.map((step) => ({
        id: `${run.id}:${step.index}`,
        runId: run.id,
        index: step.index,
        agent: step.agent || `代理 ${step.index + 1}`,
        task: step.label,
        model: step.model,
        mode: run.mode,
        status: subagentStatus(step.status, subagentStatus(run.state)),
        background: true,
        currentTool: step.currentTool ?? run.currentTool,
        currentPath: step.currentPath ?? run.currentPath,
        recentTools: subagentRecentTools(step.recentTools),
        recentOutput: subagentRecentOutput(step.recentOutput),
        toolCount: step.toolCount ?? run.toolCount ?? 0,
        turnCount: step.turnCount ?? run.turnCount,
        tokens: subagentTokens(step.tokens) || subagentTokens(run.totalTokens),
        durationMs: step.durationMs ?? Math.max(0, (run.lastUpdate ?? updatedAt) - run.startedAt),
        error: step.error ?? run.error,
        updatedAt: run.lastUpdate ?? updatedAt,
      } satisfies SubagentActivity)));
      this.mergeSubagentActivities(activities);
      if (runs.some((run) => run.state === "queued" || run.state === "running" || run.state === "paused")) {
        this.subagentRefreshTimer = setTimeout(() => {
          void this.refreshAsyncSubagents().catch((error) => {
            this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
          });
        }, 750);
      }
    } catch (error) {
      this.emitEvent({ type: "runtime_error", message: `子 Agent 状态读取失败：${errorMessage(error)}`, detail: errorDetail(error) });
    }
  }

  private subagentRpc(method: "stop" | "interrupt", id: string): Promise<unknown> {
    const active = this.requireActive();
    const requestId = `suocode-${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replyChannel = `subagents:rpc:v1:reply:${requestId}`;
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        callback();
      };
      const unsubscribe = active.eventBus.on(replyChannel, (raw) => {
        if (!isRecord(raw)) return;
        if (raw.success === true) {
          finish(() => resolvePromise(raw.data));
          return;
        }
        const rpcError = isRecord(raw.error) ? stringValue(raw.error.message) : "子 Agent 控制请求失败。";
        finish(() => rejectPromise(new Error(rpcError || "子 Agent 控制请求失败。")));
      });
      const timer = setTimeout(() => finish(() => rejectPromise(new Error("子 Agent 控制请求超时。"))), 8_000);
      active.eventBus.emit("subagents:rpc:v1:request", {
        version: 1,
        requestId,
        method,
        params: { id },
        source: { client: "suocode-desktop" },
      });
    });
  }

  async stopSubagent(id: string, background: boolean): Promise<{ stopped: true }> {
    if (!id.trim()) throw new Error("缺少子 Agent 标识。");
    await this.subagentRpc(background ? "stop" : "interrupt", id.trim());
    const active = this.requireActive();
    for (const [key, activity] of active.subagents) {
      if (activity.runId === id || activity.id === id) {
        active.subagents.set(key, { ...activity, status: "stopped", updatedAt: Date.now() });
      }
    }
    this.publishSubagents();
    await this.refreshAsyncSubagents();
    return { stopped: true };
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    const active = this.active;
    if (!active) return;
    try {
      switch (event.type) {
        case "agent_start":
          this.emitEvent({ type: "run_state", running: true });
          break;
        case "agent_settled":
          active.activeAssistantId = undefined;
          active.activeAssistantOrder = undefined;
          this.emitEvent({ type: "run_state", running: false });
          void this.snapshot().then((snapshot) => this.emitEvent({ type: "session_snapshot", snapshot }));
          this.scheduleProjectRefresh();
          void this.listSessions(active.cwd);
          break;
        case "entry_appended":
          if (event.entry.type === "custom" && event.entry.customType === RESPONSE_METRICS_ENTRY_TYPE) {
            const metrics = responseMetricsFromData(event.entry.data);
            if (metrics) {
              active.responseMetrics = metrics;
              active.responseMetricsHistory = [...active.responseMetricsHistory, metrics].slice(-60);
            }
            const usage = sessionUsage(active.session);
            this.emitEvent({
              type: "metrics_updated",
              responseMetrics: active.responseMetrics,
              responseMetricsHistory: active.responseMetricsHistory,
              contextUsage: usage.contextUsage,
              tokenUsage: usage.tokenUsage,
            });
          }
          break;
        case "session_info_changed":
          void this.snapshot().then((snapshot) => this.emitEvent({ type: "session_snapshot", snapshot }));
          void this.listSessions(active.cwd);
          break;
        case "message_start": {
          const raw = event.message as unknown;
          const role = isRecord(raw) ? stringValue(raw.role) : "message";
          const id = this.messageId(raw, role || "message");
          const order = active.nextTimelineOrder++;
          if (role === "assistant") {
            active.activeAssistantId = id;
            active.activeAssistantOrder = order;
          }
          const mapped = mapMessage(raw, id, order);
          if (mapped && mapped.role !== "tool") this.emitEvent({ type: "message_started", message: mapped });
          break;
        }
        case "message_update": {
          const update = event.assistantMessageEvent;
          const id = active.activeAssistantId ?? this.messageId(event.message as unknown, "assistant");
          active.activeAssistantId = id;
          if (update.type === "text_delta") {
            this.emitEvent({ type: "message_delta", id, field: "text", delta: update.delta });
          } else if (update.type === "thinking_delta") {
            this.emitEvent({ type: "message_delta", id, field: "thinking", delta: update.delta });
          }
          break;
        }
        case "message_end": {
          const raw = event.message as unknown;
          const role = isRecord(raw) ? stringValue(raw.role) : "message";
          const id = role === "assistant" && active.activeAssistantId
            ? active.activeAssistantId
            : this.messageId(raw, role || "message");
          const order = role === "assistant" && active.activeAssistantOrder !== undefined
            ? active.activeAssistantOrder
            : active.nextTimelineOrder++;
          const mapped = mapMessage(raw, id, order);
          if (mapped && mapped.role !== "tool") this.emitEvent({ type: "message_finished", message: mapped });
          break;
        }
        case "tool_execution_start": {
          const args = isRecord(event.args) ? { ...event.args } : {};
          const tool: ToolRun = {
            id: event.toolCallId,
            order: active.nextTimelineOrder++,
            name: event.toolName,
            label: this.toolLabel(event.toolName, args, event.toolCallId),
            args,
            output: "",
            status: "running",
            startedAt: Date.now(),
          };
          active.tools.set(tool.id, tool);
          if (event.toolName === "subagent") {
            const task = stringValue(args.task);
            const agent = stringValue(args.agent) || "子 Agent";
            const background = args.async === true;
            const placeholder: SubagentActivity = {
              id: `${tool.id}:0`,
              runId: tool.id,
              parentToolId: tool.id,
              index: 0,
              agent,
              task: task || undefined,
              model: stringValue(args.model) || undefined,
              mode: Array.isArray(args.tasks) ? "parallel" : Array.isArray(args.chain) ? "chain" : "single",
              status: "running",
              background,
              toolCount: 0,
              tokens: 0,
              durationMs: 0,
              updatedAt: tool.startedAt,
            };
            active.subagents.set(placeholder.id, placeholder);
            this.publishSubagents();
          }
          if (event.toolName === "bash" || (event.toolName === "terminal" && args.action === "start")) {
            active.terminals.set(tool.id, {
              id: tool.id,
              command: stringValue(args.command) || this.toolLabel(event.toolName, args),
              cwd: stringValue(args.cwd) || active.cwd,
              output: "",
              status: "running",
              startedAt: tool.startedAt,
            });
          }
          this.emitEvent({ type: "tool_started", tool: { ...tool } });
          this.publishProjectFromMemory();
          break;
        }
        case "tool_execution_update": {
          const tool = active.tools.get(event.toolCallId);
          if (!tool) break;
          if (isRecord(event.args)) tool.args = { ...event.args };
          const output = toolResultText(event.partialResult);
          if (output) tool.output = clampText(output, MAX_TERMINAL_OUTPUT);
          const terminal = active.terminals.get(tool.id);
          if (terminal && output) terminal.output = clampText(output, MAX_TERMINAL_OUTPUT);
          if (tool.name === "subagent") {
            const activities = subagentActivitiesFromResult(event.partialResult, tool.id, tool.args.async === true);
            if (activities.some((activity) => activity.runId !== tool.id || activity.index !== 0)) active.subagents.delete(`${tool.id}:0`);
            this.mergeSubagentActivities(activities);
          }
          this.emitEvent({ type: "tool_updated", tool: { ...tool } });
          this.publishProjectFromMemory();
          break;
        }
        case "tool_execution_end": {
          const tool = active.tools.get(event.toolCallId) ?? {
            id: event.toolCallId,
            order: active.nextTimelineOrder++,
            name: event.toolName,
            label: this.toolLabel(event.toolName, {}, event.toolCallId),
            args: {},
            output: "",
            status: "running" as const,
            startedAt: Date.now(),
          };
          tool.output = clampText(toolResultText(event.result), MAX_TERMINAL_OUTPUT);
          tool.status = event.isError ? "failed" : "succeeded";
          tool.endedAt = Date.now();
          active.tools.set(tool.id, tool);
          const terminal = active.terminals.get(tool.id);
          if (terminal) {
            terminal.output = tool.output;
            terminal.status = event.isError ? "failed" : "succeeded";
            terminal.endedAt = tool.endedAt;
            terminal.exitCode = extractExitCode(event.result);
          }
          if (event.toolName === "todo") {
            const plan = planFromResult(event.result);
            if (plan) {
              active.plan = plan;
              this.emitEvent({ type: "plan_updated", plan: [...plan] });
            }
          }
          if (event.toolName === "subagent") {
            const activities = subagentActivitiesFromResult(event.result, tool.id, tool.args.async === true);
            if (activities.length > 0) {
              if (activities.some((activity) => activity.runId !== tool.id || activity.index !== 0)) active.subagents.delete(`${tool.id}:0`);
              this.mergeSubagentActivities(activities);
            }
            else {
              const placeholder = active.subagents.get(`${tool.id}:0`);
              if (placeholder) {
                active.subagents.set(placeholder.id, {
                  ...placeholder,
                  status: event.isError ? "failed" : placeholder.background ? "running" : "completed",
                  error: event.isError ? tool.output : placeholder.error,
                  durationMs: Date.now() - placeholder.updatedAt,
                  updatedAt: Date.now(),
                });
                this.publishSubagents();
              }
            }
            void this.refreshAsyncSubagents();
          }
          this.emitEvent({ type: "tool_finished", tool: { ...tool } });
          this.publishProjectFromMemory();
          if (["write", "edit", "bash", "terminal"].includes(event.toolName)) this.scheduleProjectRefresh();
          break;
        }
        case "bash_execution_update": {
          const id = event.id ?? "session-bash";
          const current = active.terminals.get(id) ?? {
            id,
            command: "Shell 命令",
            cwd: active.cwd,
            output: "",
            status: "running" as const,
            startedAt: Date.now(),
          };
          current.output = clampText(`${current.output}${event.delta}`, MAX_TERMINAL_OUTPUT);
          active.terminals.set(id, current);
          this.publishProjectFromMemory();
          break;
        }
        default:
          break;
      }
    } catch (error) {
      this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
    }
  }

  async prompt(text: string, images?: PromptImage[]): Promise<{ accepted: true }> {
    const active = this.requireActive();
    const prompt = text.trim() || (images?.length ? "请查看附加的图片。" : "");
    if (!prompt) throw new Error("消息不能为空。");
    if (active.session.isStreaming) return this.steer(prompt, images);
    const prepared = await preparePromptImages(images);
    const expandedPrompt = prepared.hints ? `${prompt}\n\n${prepared.hints}` : prompt;

    const hasUserMessage = active.session.messages.some((message) => isRecord(message) && message.role === "user");
    if (!hasUserMessage) active.session.setSessionName(titleFromText(prompt));

    void active.session.prompt(expandedPrompt, { images: prepared.images.length ? prepared.images.map(({ mimeType, data }) => ({ type: "image" as const, mimeType, data })) : undefined }).catch((error) => {
      this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
      this.emitEvent({ type: "run_state", running: false });
    });
    return { accepted: true };
  }

  async rewindPrompt(entryId: string, text: string, images?: PromptImage[]): Promise<{ accepted: true }> {
    const active = this.requireActive();
    const prompt = text.trim() || (images?.length ? "请查看附加的图片。" : "");
    if (!prompt) throw new Error("消息不能为空。");
    if (active.session.isStreaming) throw new Error("请等待当前回复结束后再回溯。");
    const result = await active.session.navigateTree(entryId, { summarize: false });
    if (result.cancelled) throw new Error("未能回溯到所选消息。");
    const prepared = await preparePromptImages(images);
    const expandedPrompt = prepared.hints ? `${prompt}\n\n${prepared.hints}` : prompt;
    const hasUserMessage = active.session.messages.some((message) => isRecord(message) && message.role === "user");
    if (!hasUserMessage) active.session.setSessionName(titleFromText(prompt));
    this.emitEvent({ type: "session_snapshot", snapshot: await this.snapshot() });
    void active.session.prompt(expandedPrompt, {
      images: prepared.images.length ? prepared.images.map(({ mimeType, data }) => ({ type: "image" as const, mimeType, data })) : undefined,
    }).catch((error) => {
      this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
      this.emitEvent({ type: "run_state", running: false });
    });
    return { accepted: true };
  }

  async steer(text: string, images?: PromptImage[]): Promise<{ accepted: true }> {
    const active = this.requireActive();
    const prompt = text.trim() || (images?.length ? "请查看附加的图片。" : "");
    if (!prompt) throw new Error("消息不能为空。");
    const prepared = await preparePromptImages(images);
    const expandedPrompt = prepared.hints ? `${prompt}\n\n${prepared.hints}` : prompt;
    await active.session.prompt(expandedPrompt, {
      images: prepared.images.length ? prepared.images.map(({ mimeType, data }) => ({ type: "image" as const, mimeType, data })) : undefined,
      streamingBehavior: "steer",
    });
    return { accepted: true };
  }

  async abort(): Promise<{ aborted: boolean }> {
    const active = this.requireActive();
    if (!active.session.isStreaming) return { aborted: false };
    await active.session.abort();
    this.emitEvent({ type: "run_state", running: false });
    return { aborted: true };
  }

  private requireActive(): ActiveSession {
    if (!this.active) throw new Error("请先打开项目并创建会话。");
    return this.active;
  }

  async refreshProject(): Promise<ProjectSnapshot> {
    const active = this.requireActive();
    const [files, changes] = await Promise.all([directoryNodes(active.cwd), gitChanges(active.cwd)]);
    active.project = {
      cwd: active.cwd,
      files,
      changes,
      terminals: [...active.terminals.values()].sort((a, b) => b.startedAt - a.startedAt),
      plan: [...active.plan],
      refreshedAt: Date.now(),
    };
    this.emitEvent({ type: "project_updated", project: active.project });
    return active.project;
  }

  async listProjectDirectory(path: string): Promise<FileNode[]> {
    const active = this.requireActive();
    return directoryNodes(active.cwd, path);
  }

  private publishProjectFromMemory(): void {
    const active = this.active;
    if (!active) return;
    active.project = {
      ...active.project,
      terminals: [...active.terminals.values()].sort((a, b) => b.startedAt - a.startedAt),
      plan: [...active.plan],
      refreshedAt: Date.now(),
    };
    this.emitEvent({ type: "project_updated", project: active.project });
  }

  private scheduleProjectRefresh(): void {
    if (this.projectRefreshTimer) clearTimeout(this.projectRefreshTimer);
    this.projectRefreshTimer = setTimeout(() => {
      void this.refreshProject().catch((error) => {
        this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
      });
    }, 180);
  }

  async readProjectFile(path: string, maxBytes = 512 * 1024): Promise<{ path: string; content: string; truncated: boolean }> {
    const active = this.requireActive();
    const target = ensureInside(active.cwd, path);
    const fileStat = await stat(target);
    if (!fileStat.isFile()) throw new Error("所选路径不是文件。");
    const buffer = await readFile(target);
    const limit = Math.max(1, Math.min(maxBytes, 2 * 1024 * 1024));
    const truncated = buffer.byteLength > limit;
    const content = buffer.subarray(0, limit).toString("utf8");
    return { path: relative(active.cwd, target), content, truncated };
  }

  async snapshot(): Promise<SessionSnapshot> {
    const active = this.requireActive();
    const sessions = await SessionManager.list(active.cwd, this.sessionDir);
    const currentInfo = sessions.find((item) => item.id === active.session.sessionId);
    const header = active.session.sessionManager.getHeader();
    const now = new Date();
    const summary: SessionSummary = currentInfo
      ? sessionSummary(currentInfo)
      : {
          id: active.session.sessionId,
          path: active.session.sessionFile ?? "",
          cwd: active.cwd,
          title: active.session.sessionName || "新建对话",
          createdAt: header?.timestamp ?? now.toISOString(),
          updatedAt: now.toISOString(),
          messageCount: active.session.messages.length,
        };
    const reconstructed = this.reconstructState(active.session);
    const messages = reconstructed.messages;
    const model = active.session.model;
    const usage = sessionUsage(active.session);
    active.responseMetrics = reconstructed.responseMetrics ?? active.responseMetrics;
    active.responseMetricsHistory = reconstructed.responseMetricsHistory;
    return {
      session: summary,
      messages,
      tools: [...reconstructed.tools.values()].sort((a, b) => a.order - b.order),
      subagents: [...active.subagents.values()].sort((left, right) => left.updatedAt - right.updatedAt || left.index - right.index),
      project: active.project,
      model: model
        ? { provider: model.provider, id: model.id, name: model.name || model.id, reasoning: Boolean(model.reasoning) }
        : undefined,
      thinkingLevel: active.session.thinkingLevel as ThinkingLevel,
      responseMetrics: active.responseMetrics,
      responseMetricsHistory: active.responseMetricsHistory,
      contextUsage: usage.contextUsage,
      tokenUsage: usage.tokenUsage,
      running: active.session.isStreaming,
    };
  }

  async dispose(): Promise<void> {
    if (this.projectRefreshTimer) clearTimeout(this.projectRefreshTimer);
    if (this.subagentRefreshTimer) clearTimeout(this.subagentRefreshTimer);
    if (this.mcpReloadTimer) clearTimeout(this.mcpReloadTimer);
    if (this.active) {
      this.active.unsubscribe();
      await this.active.session.abort().catch(() => undefined);
      this.active.session.dispose();
      this.active.eventBus.clear();
      this.active = undefined;
    }
  }
}
