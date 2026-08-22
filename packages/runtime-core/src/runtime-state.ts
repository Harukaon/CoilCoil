import {
  type AgentSession,
  type EventBusController,
  ModelRuntime,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import {
  type ChatMessage,
  type GoalState,
  type McpRuntimeStatus,
  type PlanApprovalState,
  type ProjectMemoryRuntimeStatus,
  type ProjectSnapshot,
  type PendingSessionModel,
  type QueuedPrompt,
  type ResponseMetrics,
  type RuntimeSummaryEvent,
  type SkillConfigurationSnapshot,
  type SubagentActivity,
  type TerminalRun,
  type TodoItem,
  type ToolRun,
} from "@coilcoil/runtime-protocol";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import {
  type DiagnosticLog,
} from "@coilcoil/diagnostics";
import {
  EventSink
} from "./runtime-constants.js";
import {
  type PendingUserPrompt,
} from "./message-helpers.js";
import {
  isRecord,
  optionalString,
  stringArray
} from "./runtime-utils.js";
import { ToolRunIds } from "./tool-run-ids.js";

export interface CoilCoilRuntimeOptions {
  agentDir: string;
  sessionDir: string;
  /** Shared with every runtime in this process so one file holds the timeline. */
  log?: DiagnosticLog;
  workflowDir?: string;
  legacyAgentDir?: string;
  modelRuntime?: ModelRuntime;
  modelRuntimePromise?: Promise<ModelRuntime>;
  /** Browser capability scope owned by this runtime/session. */
  browserScopeId?: string;
  onEvent?: EventSink;
}

export interface ActiveSession {
  cwd: string;
  session: AgentSession;
  unsubscribe: () => void;
  tools: Map<string, ToolRun>;
  subagents: Map<string, SubagentActivity>;
  terminals: Map<string, TerminalRun>;
  plan: TodoItem[];
  project: ProjectSnapshot;
  messageIds: WeakMap<object, string>;
  messageRevision: number;
  /** Prompts handed to Pi whose user message it has not echoed back yet. */
  pendingUserPrompts: PendingUserPrompt[];
  promptQueue: QueuedPrompt[];
  promptDrainInProgress: boolean;
  /** Pending re-check for a queue held back only by Pi's streaming flag. */
  drainRetryTimer?: ReturnType<typeof setTimeout>;
  activeUserId?: string;
  activeUserOrder?: number;
  lastUserId?: string;
  activeAssistantId?: string;
  activeAssistantOrder?: number;
  activeAssistantMessage?: ChatMessage;
  nextTimelineOrder: number;
  /** Keeps repeated provider tool call ids from colliding; see ToolRunIds. */
  toolRunIds: ToolRunIds;
  responseMetrics?: ResponseMetrics;
  responseMetricsHistory: ResponseMetrics[];
  sessionRevision: number;
  summaryActivity?: RuntimeSummaryEvent;
  bridgeState?: RuntimeBridgeState;
  fastState?: FastRuntimeState;
  memoryStatus?: ProjectMemoryRuntimeStatus;
  skillConfiguration?: SkillConfigurationSnapshot;
  mcpStatus?: McpRuntimeStatus;
  planApproval?: PlanApprovalState;
  /** Live `/goal` loop state, mirrored from the workflow extension. */
  goal?: GoalState;
  /** A stop was delivered and the run has not settled yet. */
  aborting?: boolean;
  /** A stop that arrived before the run existed; it lands when the run starts. */
  abortOnStart?: boolean;
  /** Model selected while a turn was already running; applied before the next prompt. */
  pendingModel?: PendingSessionModel;
  eventBus: EventBusController;
}

export interface FastRuntimeState {
  version: 1;
  enabled: boolean;
  supported: boolean;
  modelId?: string;
}

export interface RuntimeBridgeState {
  version: 1;
  effectiveSystemPrompt?: string;
  systemPromptOverride?: string;
  disabledSkills: string[];
  readSkills: string[];
  contextMessages?: unknown[];
  updatedAt: number;
}

export interface ReconstructedSessionState {
  messages: ChatMessage[];
  tools: Map<string, ToolRun>;
  subagents: Map<string, SubagentActivity>;
  terminals: Map<string, TerminalRun>;
  plan: TodoItem[];
  nextTimelineOrder: number;
  /** Seeded by the replay so live calls keep counting from the restored runs. */
  toolRunIds: ToolRunIds;
  responseMetrics?: ResponseMetrics;
  responseMetricsHistory: ResponseMetrics[];
  planApproval?: PlanApprovalState;
}

export interface WorkflowManifest {
  pi?: {
    extensions?: string[];
    skills?: string[];
    prompts?: string[];
  };
}

export interface RuntimeResources {
  extensions: string[];
  skills: string[];
  prompts: string[];
}

export function runtimeBridgeState(value: unknown): RuntimeBridgeState | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  return {
    version: 1,
    effectiveSystemPrompt: optionalString(value, "effectiveSystemPrompt"),
    systemPromptOverride: optionalString(value, "systemPromptOverride"),
    disabledSkills: stringArray(value.disabledSkills),
    readSkills: stringArray(value.readSkills),
    contextMessages: Array.isArray(value.contextMessages) ? value.contextMessages : undefined,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
  };
}

export function fastRuntimeState(value: unknown): FastRuntimeState | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.enabled !== "boolean" || typeof value.supported !== "boolean") return undefined;
  return {
    version: 1,
    enabled: value.enabled,
    supported: value.supported,
    modelId: optionalString(value, "modelId"),
  };
}

/** True when the payload says the loop is over, which means the session has no goal. */
export function endedGoalPayload(value: unknown): boolean {
  return isRecord(value) && (value.status === "completed" || value.status === "stopped");
}

export function goalState(value: unknown): GoalState | undefined {
  if (!isRecord(value)) return undefined;
  const statuses = new Set<GoalState["status"]>(["running", "paused"]);
  if (!statuses.has(value.status as GoalState["status"])) return undefined;
  const goal = optionalString(value, "goal");
  if (!goal) return undefined;
  const number = (key: string, fallback: number): number => (
    typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] as number : fallback
  );
  return {
    status: value.status as GoalState["status"],
    goal,
    iteration: Math.max(0, Math.floor(number("iteration", 0))),
    startedAt: number("startedAt", Date.now()),
    updatedAt: number("updatedAt", Date.now()),
    summary: optionalString(value, "summary"),
    lastError: optionalString(value, "lastError"),
  };
}

export function planApprovalState(value: unknown): PlanApprovalState | undefined {
  if (!isRecord(value)) return undefined;
  const statuses = new Set<PlanApprovalState["status"]>([
    "pending_approval", "running", "delegated", "completed", "rejected", "failed",
  ]);
  if (!statuses.has(value.status as PlanApprovalState["status"])) return undefined;
  const id = optionalString(value, "id");
  const filePath = optionalString(value, "filePath");
  const legacyMarkdown = (() => {
    const title = optionalString(value, "title");
    const objective = optionalString(value, "objective");
    if (!title || !objective) return undefined;
    const steps = Array.isArray(value.steps)
      ? value.steps.flatMap((raw) => isRecord(raw) && optionalString(raw, "text")
        ? [`- [${raw.status === "completed" ? "x" : " "}] ${optionalString(raw, "text")}`]
        : [])
      : [];
    const criteria = stringArray(value.acceptanceCriteria);
    return [
      `# ${title}`,
      "",
      "## 目标",
      objective,
      ...(steps.length ? ["", "## 执行步骤", ...steps] : []),
      ...(criteria.length ? ["", "## 验收标准", ...criteria.map((item) => `- ${item}`)] : []),
      ...(optionalString(value, "notes") ? ["", "## 备注", optionalString(value, "notes")!] : []),
    ].join("\n");
  })();
  const markdown = (optionalString(value, "markdown") ?? legacyMarkdown)
    ?.replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (!id || !markdown || !filePath) return undefined;
  const title = optionalString(value, "title")
    ?? markdown.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim()
    ?? markdown.split("\n").find((line) => line.trim())?.replace(/^#+\s*/, "").trim()
    ?? "执行计划";
  const number = (key: string, fallback: number): number => typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] as number : fallback;
  const target = value.executionTarget === "main" || value.executionTarget === "subagent" ? value.executionTarget : undefined;
  return {
    id,
    title,
    markdown,
    filePath,
    revision: Math.max(1, Math.floor(number("revision", 1))),
    status: value.status as PlanApprovalState["status"],
    createdAt: number("createdAt", Date.now()),
    updatedAt: number("updatedAt", Date.now()),
    executionTarget: target,
    agentProfile: optionalString(value, "agentProfile"),
    subagentRunId: optionalString(value, "subagentRunId"),
    report: optionalString(value, "report"),
    error: optionalString(value, "error"),
  };
}

export function projectMemoryStatus(value: unknown): ProjectMemoryRuntimeStatus | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  const states = new Set<ProjectMemoryRuntimeStatus["state"]>(["idle", "running", "busy", "succeeded", "failed", "disabled"]);
  const sources = new Set<ProjectMemoryRuntimeStatus["source"]>(["startup", "prompt", "manual", "automatic"]);
  if (!states.has(value.state as ProjectMemoryRuntimeStatus["state"]) || !sources.has(value.source as ProjectMemoryRuntimeStatus["source"])) return undefined;
  const number = (key: string): number | undefined => typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : undefined;
  return {
    cwd: optionalString(value, "cwd") ?? "",
    updatedAt: number("updatedAt") ?? Date.now(),
    attemptId: optionalString(value, "attemptId"),
    state: value.state as ProjectMemoryRuntimeStatus["state"],
    source: value.source as ProjectMemoryRuntimeStatus["source"],
    exists: value.exists === true,
    injected: value.injected === true,
    projectRoot: optionalString(value, "projectRoot"),
    projectName: optionalString(value, "projectName"),
    memoryFile: optionalString(value, "memoryFile"),
    projectMemoryDir: optionalString(value, "projectMemoryDir"),
    contentChars: number("contentChars"),
    estimatedTokens: number("estimatedTokens"),
    content: optionalString(value, "content"),
    sessionFile: optionalString(value, "sessionFile"),
    processedSessions: stringArray(value.processedSessions),
    startedAt: number("startedAt"),
    completedAt: number("completedAt"),
    durationMs: number("durationMs"),
    message: optionalString(value, "message"),
    error: optionalString(value, "error"),
  };
}

export function hydrateProjectMemoryStatus(status: ProjectMemoryRuntimeStatus): ProjectMemoryRuntimeStatus {
  if (!status.memoryFile || !status.exists || !existsSync(status.memoryFile)) return status;
  try {
    return { ...status, content: readFileSync(status.memoryFile, "utf8") };
  } catch {
    return status;
  }
}

export function mergedSessionPaths(...groups: readonly string[][]): string[] {
  return [...new Set(groups.flat().filter(Boolean))];
}

export function isWorkspaceMemoryJob(status: ProjectMemoryRuntimeStatus): boolean {
  return status.source === "manual" || status.source === "automatic";
}

export function memoryAttemptStartedAt(status: ProjectMemoryRuntimeStatus): number {
  return status.startedAt ?? status.updatedAt;
}

export function mergeWorkspaceMemoryStatus(
  previous: ProjectMemoryRuntimeStatus | undefined,
  incoming: ProjectMemoryRuntimeStatus,
): ProjectMemoryRuntimeStatus {
  const processedSessions = mergedSessionPaths(
    previous?.processedSessions ?? [],
    incoming.processedSessions,
  );
  const sessionMetadataOnly = !isWorkspaceMemoryJob(incoming);
  if (!previous) return { ...incoming, injected: false, processedSessions };

  if (sessionMetadataOnly) {
    if (!isWorkspaceMemoryJob(previous)) {
      return { ...previous, ...incoming, injected: false, processedSessions };
    }
    return {
      ...incoming,
      ...previous,
      exists: incoming.exists,
      projectRoot: incoming.projectRoot ?? previous.projectRoot,
      projectName: incoming.projectName ?? previous.projectName,
      memoryFile: incoming.memoryFile ?? previous.memoryFile,
      projectMemoryDir: incoming.projectMemoryDir ?? previous.projectMemoryDir,
      contentChars: incoming.contentChars ?? previous.contentChars,
      estimatedTokens: incoming.estimatedTokens ?? previous.estimatedTokens,
      content: incoming.content ?? previous.content,
      processedSessions,
      injected: false,
      updatedAt: Math.max(previous.updatedAt, incoming.updatedAt),
    };
  }

  if (isWorkspaceMemoryJob(previous)) {
    const sameAttempt = Boolean(incoming.attemptId && incoming.attemptId === previous.attemptId);
    const incomingStartedAt = memoryAttemptStartedAt(incoming);
    const previousStartedAt = memoryAttemptStartedAt(previous);
    const staleAttempt = !sameAttempt
      && Boolean(incoming.attemptId && previous.attemptId)
      && incomingStartedAt < previousStartedAt;
    const busyWhileRunning = incoming.state === "busy" && previous.state === "running";
    if (staleAttempt || busyWhileRunning) {
      return {
        ...previous,
        processedSessions,
        content: incoming.content ?? previous.content,
        contentChars: incoming.contentChars ?? previous.contentChars,
        estimatedTokens: incoming.estimatedTokens ?? previous.estimatedTokens,
      };
    }
  }

  return { ...previous, ...incoming, injected: false, processedSessions };
}

export function memoryStatusForInspection(
  local: ProjectMemoryRuntimeStatus | undefined,
  shared: ProjectMemoryRuntimeStatus | undefined,
): ProjectMemoryRuntimeStatus | undefined {
  if (!local) return shared;
  if (!shared) return local;
  const sharedWins = isWorkspaceMemoryJob(shared)
    || (!isWorkspaceMemoryJob(local) && shared.updatedAt >= local.updatedAt);
  const primary = sharedWins ? shared : local;
  const secondary = sharedWins ? local : shared;
  return {
    ...secondary,
    ...primary,
    injected: local.injected,
    processedSessions: mergedSessionPaths(local.processedSessions, shared.processedSessions),
  };
}

export async function shutdownAgentSession(
  session: AgentSession,
  reason: SessionShutdownEvent["reason"] = "quit",
): Promise<void> {
  try {
    // `abort()` waits for the session to go idle, and a summarization in flight
    // holds it there for as long as the summary takes. `dispose()` cancels one,
    // but only in the `finally` below — far too late to keep this wait short.
    session.abortCompaction();
    session.abortBranchSummary();
    await session.abort().catch(() => undefined);
    if (session.extensionRunner.hasHandlers("session_shutdown")) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason });
    }
  } finally {
    session.dispose();
  }
}
