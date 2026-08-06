export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ProjectSelection {
  name: string;
  path: string;
  kind: "home" | "workspace";
}

export interface ModelOption {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  reasoning: boolean;
  supportedThinkingLevels: ThinkingLevel[];
  contextWindow?: number;
  configured: boolean;
}

export interface RuntimeConfiguration {
  provider?: string;
  modelId?: string;
  thinkingLevel: ThinkingLevel;
  configuredProviders: string[];
  models: ModelOption[];
  migratedLegacyCredentials: boolean;
}

export interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export type ChatRole = "user" | "assistant" | "tool" | "system";

export interface ChatMessage {
  id: string;
  entryId?: string;
  order: number;
  role: ChatRole;
  text: string;
  thinking?: string;
  timestamp: number;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  status?: "running" | "succeeded" | "failed" | "aborted";
}

export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ToolRun {
  id: string;
  order: number;
  name: string;
  label: string;
  args: Record<string, unknown>;
  output: string;
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  endedAt?: number;
}

export interface ResponseMetrics {
  firstTokenMs?: number;
  averageTokensPerSecond?: number;
  inputTokens?: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalMs: number;
  turnDurationMs: number;
  timestamp: number;
}

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface TerminalRun {
  id: string;
  command: string;
  cwd: string;
  output: string;
  status: "running" | "succeeded" | "failed" | "stopped";
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
}

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface FileNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  children?: FileNode[];
}

export interface ProjectSnapshot {
  cwd: string;
  files: FileNode[];
  changes: ChangedFile[];
  terminals: TerminalRun[];
  plan: TodoItem[];
  refreshedAt: number;
}

export interface SessionSnapshot {
  runtimeId?: string;
  session: SessionSummary;
  messages: ChatMessage[];
  tools: ToolRun[];
  project: ProjectSnapshot;
  model?: Pick<ModelOption, "provider" | "id" | "name" | "reasoning">;
  thinkingLevel: ThinkingLevel;
  responseMetrics?: ResponseMetrics;
  responseMetricsHistory: ResponseMetrics[];
  contextUsage?: ContextUsage;
  tokenUsage: TokenUsage;
  running: boolean;
}

export interface RuntimeBootstrap {
  configuration: RuntimeConfiguration;
  activeSession?: SessionSnapshot;
}

export type RuntimeCommand =
  | { type: "bootstrap" }
  | { type: "get_configuration" }
  | {
      type: "configure_model";
      provider: string;
      modelId: string;
      thinkingLevel: ThinkingLevel;
      apiKey?: string;
    }
  | { type: "remove_provider_auth"; provider: string }
  | { type: "list_sessions"; cwd: string }
  | { type: "create_session"; cwd: string }
  | { type: "open_session"; cwd: string; sessionPath: string }
  | { type: "prompt"; text: string }
  | { type: "rewind_prompt"; entryId: string; text: string }
  | { type: "steer"; text: string }
  | { type: "abort" }
  | { type: "refresh_project" }
  | { type: "list_directory"; path: string }
  | { type: "read_file"; path: string; maxBytes?: number };

export type RuntimeEvent =
  | { type: "runtime_ready"; configuration: RuntimeConfiguration }
  | { type: "configuration_updated"; configuration: RuntimeConfiguration }
  | { type: "sessions_updated"; cwd: string; sessions: SessionSummary[] }
  | { type: "session_snapshot"; snapshot: SessionSnapshot }
  | { type: "message_started"; message: ChatMessage }
  | { type: "message_delta"; id: string; field: "text" | "thinking"; delta: string }
  | { type: "message_finished"; message: ChatMessage }
  | { type: "tool_started"; tool: ToolRun }
  | { type: "tool_updated"; tool: ToolRun }
  | { type: "tool_finished"; tool: ToolRun }
  | { type: "plan_updated"; plan: TodoItem[] }
  | { type: "project_updated"; project: ProjectSnapshot }
  | {
      type: "metrics_updated";
      responseMetrics?: ResponseMetrics;
      responseMetricsHistory: ResponseMetrics[];
      contextUsage?: ContextUsage;
      tokenUsage: TokenUsage;
    }
  | { type: "run_state"; running: boolean }
  | { type: "runtime_error"; message: string; detail?: string };

export interface RuntimeCommandEnvelope {
  id: string;
  command: RuntimeCommand;
}

export interface RuntimeResponseEnvelope {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface RuntimeEventEnvelope {
  event: RuntimeEvent;
}

export interface ScopedRuntimeEvent {
  runtimeId?: string;
  event: RuntimeEvent;
}

export type RuntimeWireMessage = RuntimeResponseEnvelope | RuntimeEventEnvelope;

export function isRuntimeCommandEnvelope(value: unknown): value is RuntimeCommandEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RuntimeCommandEnvelope>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.command === "object" &&
    candidate.command !== null &&
    typeof (candidate.command as { type?: unknown }).type === "string"
  );
}

export function isRuntimeEventEnvelope(value: unknown): value is RuntimeEventEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "event" in value &&
    typeof (value as RuntimeEventEnvelope).event?.type === "string"
  );
}
