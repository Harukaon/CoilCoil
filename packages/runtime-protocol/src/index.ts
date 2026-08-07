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
  supportsImages: boolean;
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

/**
 * Pi's built-in streaming transports that can be configured through
 * `models.json`. The runtime deliberately keeps the value as a string so a
 * newer Pi transport can be exposed before SuoCode itself needs a release.
 */
export interface ModelProviderApiOption {
  id: string;
  label: string;
  description: string;
}

export interface ModelProviderCredentialField {
  /** `key` writes to the Pi credential key; environment names write to credential.env. */
  id: string;
  label: string;
  input: "text" | "secret" | "textarea";
  required: boolean;
  placeholder?: string;
  description?: string;
  /** The value is returned only for non-secret fields. */
  value?: string;
  configured: boolean;
}

export interface ModelProviderCredentialMethod {
  id: string;
  label: string;
  description?: string;
  fields: ModelProviderCredentialField[];
}

/** Pi-native authentication capabilities projected into the desktop settings UI. */
export interface ModelProviderCredentialConfiguration {
  name?: string;
  selectedMethod?: string;
  methods: ModelProviderCredentialMethod[];
  oauth?: {
    name: string;
    label: string;
  };
}

export interface ModelCostConfiguration {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: Array<{
    inputTokensAbove: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }>;
}

/** A serializable subset of a Pi `models.json` model definition. */
export interface ModelProviderModelConfiguration {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCostConfiguration;
  samplingParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

/**
 * A provider entry projected from SuoCode's private Pi `models.json`.
 * Credentials are intentionally represented only as availability/reference
 * metadata; the literal key stays in Pi's private auth store.
 */
export interface ModelProviderConfiguration {
  id: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  oauth?: "radius";
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  authHeader?: boolean;
  /** Pi value expression such as `$MY_KEY` or `!op read ...`, never a raw key. */
  apiKeyReference?: string;
  /** A literal `models.json` API key exists but is intentionally redacted. */
  hasPrivateApiKeyReference: boolean;
  apiKeyConfigured: boolean;
  credential: ModelProviderCredentialConfiguration;
  /** `models` exists in models.json and replaces Pi's catalog for this provider. */
  replaceModels: boolean;
  models: ModelProviderModelConfiguration[];
  modelOverrides?: Record<string, Omit<ModelProviderModelConfiguration, "id" | "api" | "baseUrl">>;
  source: "built-in" | "custom" | "override";
}

/** Editable provider input. `apiKey` is write-only and never returned. */
export interface ModelProviderConfigurationInput {
  provider: Omit<ModelProviderConfiguration, "apiKeyConfigured" | "hasPrivateApiKeyReference" | "source" | "credential">;
  credential?: {
    method: string;
    values: Record<string, string>;
    /** Keep configured secret fields whose inputs were intentionally left blank. */
    preserveFields: string[];
  };
  /** @deprecated Use `credential`; retained for older CLI/runtime clients. */
  apiKey?: string;
  /** Keep an existing redacted literal or expression from models.json. */
  preserveApiKeyReference?: boolean;
}

export interface ModelProviderConfigurationSnapshot {
  configPath: string;
  providers: ModelProviderConfiguration[];
  supportedApis: ModelProviderApiOption[];
}

export interface ModelProviderSaveResult {
  provider: ModelProviderConfiguration;
  configuration: RuntimeConfiguration;
}

export type McpTransport = "stdio" | "http";

export interface McpServerConfiguration {
  name: string;
  scope: "global" | "project";
  transport: McpTransport;
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
  auth?: "oauth" | "bearer" | false;
  bearerTokenEnv?: string;
  lifecycle: "keep-alive" | "lazy" | "eager";
  idleTimeout?: number;
  requestTimeoutMs?: number;
  exposeResources: boolean;
  directTools: boolean | string[];
  excludeTools: string[];
  debug: boolean;
  disabled: boolean;
  source?: string;
  sourceKind?: "user" | "project" | "import";
}

export interface McpImportConfiguration {
  kind: "cursor" | "claude-code" | "claude-desktop" | "codex" | "opencode" | "windsurf" | "vscode";
  path: string;
  serverCount: number;
  enabled: boolean;
}

export interface McpConfigurationSnapshot {
  configPath: string;
  projectConfigPath?: string;
  servers: McpServerConfiguration[];
  imports: McpImportConfiguration[];
}

export interface McpServerRuntimeStatus {
  name: string;
  status: "connected" | "needs-auth" | "failed" | "cached" | "not connected" | "disabled";
  toolCount: number;
  resourceCount: number;
  failedAgo: number | null;
  disabled: boolean;
}

export interface McpRuntimeStatus {
  servers: McpServerRuntimeStatus[];
  totalTools: number;
  totalResources: number;
  connectedCount: number;
  disabledCount: number;
  state?: "ready" | "initializing" | "unavailable";
  diagnostic?: string;
}

export interface McpActionResult {
  text: string;
  details?: Record<string, unknown>;
  status?: McpRuntimeStatus;
}

export interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  archivedAt?: string;
}

export type ChatRole = "user" | "assistant" | "tool" | "system";

export interface PromptImage {
  id?: string;
  mimeType: string;
  data: string;
  name?: string;
}

export interface ChatMessage {
  id: string;
  entryId?: string;
  order: number;
  role: ChatRole;
  model?: Pick<ModelOption, "provider" | "id">;
  text: string;
  images?: PromptImage[];
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

export type SubagentActivityStatus = "pending" | "running" | "completed" | "failed" | "stopped" | "paused" | "detached";

export interface SubagentRecentTool {
  tool: string;
  args: string;
}

export interface SubagentToolCall {
  text: string;
  expandedText?: string;
}

export interface SubagentMessage {
  role: string;
  text: string;
  thinking?: string;
}

export interface SubagentActivity {
  id: string;
  runId: string;
  parentToolId?: string;
  index: number;
  agent: string;
  task?: string;
  model?: string;
  mode: "single" | "parallel" | "chain";
  status: SubagentActivityStatus;
  background: boolean;
  controlReady?: boolean;
  currentTool?: string;
  currentPath?: string;
  recentTools?: SubagentRecentTool[];
  recentOutput?: string[];
  messages?: SubagentMessage[];
  toolCalls?: SubagentToolCall[];
  finalOutput?: string;
  transcriptPath?: string;
  sessionFile?: string;
  toolCount: number;
  turnCount?: number;
  tokens: number;
  durationMs: number;
  error?: string;
  updatedAt: number;
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
  subagents: SubagentActivity[];
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
  | { type: "get_model_provider_configuration" }
  | { type: "save_model_provider_configuration"; input: ModelProviderConfigurationInput }
  | { type: "remove_model_provider_configuration"; provider: string }
  | {
      type: "configure_model";
      provider: string;
      modelId: string;
      thinkingLevel: ThinkingLevel;
      apiKey?: string;
    }
  | { type: "remove_provider_auth"; provider: string }
  | { type: "get_mcp_configuration"; cwd?: string }
  | { type: "get_mcp_status" }
  | { type: "save_mcp_server"; server: McpServerConfiguration; previousName?: string; cwd?: string }
  | { type: "remove_mcp_server"; name: string; scope?: "global" | "project"; cwd?: string }
  | { type: "set_mcp_server_enabled"; name: string; enabled: boolean; cwd: string }
  | { type: "enable_mcp_imports"; imports: McpImportConfiguration["kind"][]; cwd?: string }
  | { type: "connect_mcp_server"; name: string }
  | { type: "start_mcp_auth"; name: string }
  | { type: "complete_mcp_auth"; name: string; input: string }
  | { type: "logout_mcp_server"; name: string }
  | { type: "stop_subagent"; id: string; background: boolean }
  | { type: "list_sessions"; cwd: string }
  | { type: "list_archived_sessions"; cwd: string }
  | { type: "archive_session"; cwd: string; sessionPath: string }
  | { type: "restore_session"; cwd: string; sessionPath: string }
  | { type: "create_session"; cwd: string }
  | { type: "open_session"; cwd: string; sessionPath: string }
  | { type: "prompt"; text: string; images?: PromptImage[] }
  | { type: "rewind_prompt"; entryId: string; text: string; images?: PromptImage[] }
  | { type: "steer"; text: string; images?: PromptImage[] }
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
  | { type: "subagents_updated"; subagents: SubagentActivity[] }
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
  runtimeId?: string;
  command: RuntimeCommand;
}

export interface RuntimeResponseEnvelope {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface RuntimeEventEnvelope {
  runtimeId?: string;
  event: RuntimeEvent;
}

export type ScopedRuntimeEvent = RuntimeEventEnvelope;

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
