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

/** An explicit model choice carried across a session boundary. */
export interface SessionModelSelection {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/** Configuration for SuoCode's own OpenAI Responses WebSocket Pi extension. */
export interface OpenAIResponsesWsConfiguration {
  configPath: string;
  baseUrl: string;
  apiKeyConfigured: boolean;
  fast: boolean;
}

export interface OpenAIResponsesWsConfigurationInput {
  baseUrl: string;
  apiKey?: string;
  preserveApiKey: boolean;
  fast?: boolean;
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

export type ModelProviderAuthPrompt =
  | { id: string; type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | {
      id: string;
      type: "select";
      message: string;
      options: Array<{ id: string; label: string; description?: string }>;
    };

export interface ModelProviderAuthState {
  flowId: string;
  provider: string;
  providerName: string;
  loginLabel: string;
  status: "starting" | "waiting_for_user" | "authorizing" | "succeeded" | "failed" | "cancelled";
  message?: string;
  prompt?: ModelProviderAuthPrompt;
  authUrl?: {
    url: string;
    instructions?: string;
  };
  deviceCode?: {
    userCode: string;
    verificationUri: string;
    expiresInSeconds?: number;
  };
  links?: Array<{ url: string; label?: string }>;
  error?: string;
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
  /** The active stored/resolved credential kind. No secret material is exposed. */
  authType?: "api_key" | "oauth";
  /** Soft-disable: keep config but hide models from the picker. */
  disabled: boolean;
  credential: ModelProviderCredentialConfiguration;
  /** `models` exists in models.json and replaces Pi's catalog for this provider. */
  replaceModels: boolean;
  models: ModelProviderModelConfiguration[];
  modelOverrides?: Record<string, Omit<ModelProviderModelConfiguration, "id" | "api" | "baseUrl">>;
  source: "built-in" | "custom" | "override";
}

/** Editable provider input. `apiKey` is write-only and never returned. */
export interface ModelProviderConfigurationInput {
  provider: Omit<ModelProviderConfiguration, "apiKeyConfigured" | "authType" | "hasPrivateApiKeyReference" | "source" | "credential">;
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

export interface FetchProviderModelsInput {
  baseUrl: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Use stored auth.json credentials for this provider when apiKey is omitted. */
  provider?: string;
}

export interface FetchProviderModelsResult {
  models: Array<{ id: string; name?: string }>;
}

export interface TestProviderConnectionInput {
  baseUrl: string;
  api: string;
  apiKey?: string;
  headers?: Record<string, string>;
  modelId?: string;
  /** Use stored auth.json credentials for this provider when apiKey is omitted. */
  provider?: string;
}

export interface TestProviderConnectionResult {
  ok: boolean;
  message: string;
  detail?: string;
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
  /**
   * Which app an imported definition came from. For imports the adapter sets
   * `source` to SuoCode's own config path (that is where overrides get written),
   * so this is the only field that identifies the true origin.
   */
  importKind?: McpImportConfiguration["kind"];
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

export interface McpJsonDocument {
  path: string;
  content: string;
}

export type McpJsonValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const MCP_IMPORT_KINDS = new Set([
  "cursor",
  "claude-code",
  "claude-desktop",
  "codex",
  "opencode",
  "windsurf",
  "vscode",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown, label: string): string | undefined {
  if (!isPlainObject(value)) return `${label} 必须是对象。`;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return `${label}.${key} 必须是字符串。`;
  }
  return undefined;
}

/** Validate Cursor-compatible mcp.json text before writing. Rejects invalid JSON to keep MCP usable. */
export function validateMcpJsonText(text: string): McpJsonValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `JSON 语法错误：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: "根节点必须是 JSON 对象，例如 { \"mcpServers\": {} }。" };
  if (!("mcpServers" in parsed)) return { ok: false, error: "缺少 mcpServers 字段。" };
  if (!isPlainObject(parsed.mcpServers)) return { ok: false, error: "mcpServers 必须是对象。" };

  for (const [name, entry] of Object.entries(parsed.mcpServers)) {
    if (!name.trim()) return { ok: false, error: "存在空的 MCP 服务器名称。" };
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      return { ok: false, error: `MCP 名称「${name}」只能包含字母、数字、点、下划线和连字符。` };
    }
    if (!isPlainObject(entry)) return { ok: false, error: `mcpServers.${name} 必须是对象。` };
    const hasCommand = typeof entry.command === "string" && entry.command.trim().length > 0;
    const hasUrl = typeof entry.url === "string" && entry.url.trim().length > 0;
    // An entry may carry only overrides for a server that is defined elsewhere —
    // an imported Cursor/Claude/Codex config, or a shared `.mcp.json`. Removing
    // such a server can only tombstone it as `{ "disabled": true }` here, so
    // demanding a transport would reject files SuoCode itself writes.
    const overrideOnly = !hasCommand && !hasUrl
      && Object.keys(entry).every((key) => key === "disabled" || key === "excludeTools");
    if (!hasCommand && !hasUrl && !overrideOnly) {
      return { ok: false, error: `mcpServers.${name} 需要提供 command（stdio）或 url（HTTP）。` };
    }
    if (hasCommand && hasUrl) {
      return { ok: false, error: `mcpServers.${name} 不能同时设置 command 与 url。` };
    }
    if (entry.args !== undefined) {
      if (!Array.isArray(entry.args) || entry.args.some((item) => typeof item !== "string")) {
        return { ok: false, error: `mcpServers.${name}.args 必须是字符串数组。` };
      }
    }
    if (entry.env !== undefined) {
      const error = isStringRecord(entry.env, `mcpServers.${name}.env`);
      if (error) return { ok: false, error };
    }
    if (entry.headers !== undefined) {
      const error = isStringRecord(entry.headers, `mcpServers.${name}.headers`);
      if (error) return { ok: false, error };
    }
    if (entry.cwd !== undefined && typeof entry.cwd !== "string") {
      return { ok: false, error: `mcpServers.${name}.cwd 必须是字符串。` };
    }
    if (entry.auth !== undefined && entry.auth !== "oauth" && entry.auth !== "bearer" && entry.auth !== false) {
      return { ok: false, error: `mcpServers.${name}.auth 只能是 oauth、bearer 或 false。` };
    }
    if (entry.disabled !== undefined && typeof entry.disabled !== "boolean") {
      return { ok: false, error: `mcpServers.${name}.disabled 必须是布尔值。` };
    }
    if (entry.lifecycle !== undefined && entry.lifecycle !== "lazy" && entry.lifecycle !== "keep-alive" && entry.lifecycle !== "eager") {
      return { ok: false, error: `mcpServers.${name}.lifecycle 只能是 lazy、keep-alive 或 eager。` };
    }
  }

  if (parsed.imports !== undefined) {
    if (!Array.isArray(parsed.imports) || parsed.imports.some((item) => typeof item !== "string" || !MCP_IMPORT_KINDS.has(item))) {
      return { ok: false, error: "imports 必须是受支持的导入源字符串数组。" };
    }
  }

  if (parsed.settings !== undefined && !isPlainObject(parsed.settings)) {
    return { ok: false, error: "settings 必须是对象。" };
  }

  return { ok: true, value: parsed };
}

export interface McpServerRuntimeStatus {
  name: string;
  status: "connected" | "needs-auth" | "failed" | "cached" | "not connected" | "disabled";
  toolCount: number;
  resourceCount: number;
  failedAgo: number | null;
  disabled: boolean;
  /** Disabled only for this Pi session; the workspace configuration is unchanged. */
  sessionDisabled: boolean;
}

export interface McpRuntimeStatus {
  servers: McpServerRuntimeStatus[];
  totalTools: number;
  totalResources: number;
  connectedCount: number;
  disabledCount: number;
  sessionDisabledCount: number;
  state?: "ready" | "initializing" | "unavailable";
  diagnostic?: string;
}

export interface McpActionResult {
  text: string;
  details?: Record<string, unknown>;
  status?: McpRuntimeStatus;
}

export type SkillSource = "user" | "project" | "agents" | "bundled";

export interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: SkillSource;
  enabled: boolean;
  disableModelInvocation: boolean;
  scope: "user" | "project";
}

export interface SkillDiagnostic {
  type: "warning" | "error" | "collision";
  message: string;
  path?: string;
}

export interface SkillConfigurationSnapshot {
  agentDir: string;
  userSkillsDir: string;
  projectSkillsDir?: string;
  agentsSkillsDir: string;
  skillPaths: string[];
  projectSkillPaths: string[];
  customSkillPaths: string[];
  enableSkillCommands: boolean;
  skills: SkillEntry[];
  diagnostics: SkillDiagnostic[];
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
  pinned?: boolean;
  pinnedAt?: string;
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

export type PlanApprovalStatus =
  | "pending_approval"
  | "running"
  | "delegated"
  | "completed"
  | "rejected"
  | "failed";

export type PlanExecutionTarget = "main" | "subagent";

export interface PlanApprovalState {
  id: string;
  title: string;
  /** The complete plan document. It is persisted to file without extra metadata. */
  markdown: string;
  filePath: string;
  revision: number;
  status: PlanApprovalStatus;
  createdAt: number;
  updatedAt: number;
  executionTarget?: PlanExecutionTarget;
  agentProfile?: string;
  subagentRunId?: string;
  report?: string;
  error?: string;
}

export type SubagentActivityStatus = "pending" | "running" | "completed" | "failed" | "stopped";

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

export type SubagentTimelineEntry =
  | {
      id: string;
      order: number;
      kind: "message";
      role: string;
      text: string;
      thinking?: string;
    }
  | {
      id: string;
      order: number;
      kind: "tool";
      tool: string;
      args: string;
      expandedArgs?: string;
      output?: string;
      status: "running" | "succeeded" | "failed";
    };

export interface SubagentActivity {
  id: string;
  runId: string;
  parentToolId?: string;
  index: number;
  agent: string;
  task?: string;
  model?: string;
  status: SubagentActivityStatus;
  background: boolean;
  controlReady?: boolean;
  resumable?: boolean;
  currentTool?: string;
  currentPath?: string;
  recentTools?: SubagentRecentTool[];
  recentOutput?: string[];
  messages?: SubagentMessage[];
  toolCalls?: SubagentToolCall[];
  /** Ordered child-session events used by the read-only miniature conversation UI. */
  timeline?: SubagentTimelineEntry[];
  finalOutput?: string;
  transcriptPath?: string;
  sessionFile?: string;
  worktreePath?: string;
  toolCount: number;
  turnCount?: number;
  tokens: number;
  durationMs: number;
  error?: string;
  updatedAt: number;
  /** Durable plan that dispatched this run, when applicable. */
  planId?: string;
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

export interface CacheUsageSummary {
  /** Full prompt volume. Pi exposes input/cacheRead/cacheWrite as non-overlapping buckets. */
  promptTokens: number;
  /** Tokens billed as fresh input, including tokens written into the prompt cache. */
  uncachedTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Read share of the full prompt. Undefined when the prompt is empty. */
  hitRate?: number;
}

/**
 * Normalize Pi's provider-independent cache buckets for display.
 *
 * Pi deliberately stores `input`, `cacheRead`, and `cacheWrite` as mutually
 * exclusive buckets, even for providers such as OpenAI that report cached
 * tokens as a subset of their input total. Do not display `input` alone as the
 * full prompt size and do not add output tokens to the cache denominator.
 */
export function summarizeCacheUsage(
  inputTokens: number | null | undefined,
  cacheReadTokens: number | null | undefined,
  cacheWriteTokens: number | null | undefined,
): CacheUsageSummary {
  const safe = (value: number | null | undefined): number => Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
  const input = safe(inputTokens);
  const cacheRead = safe(cacheReadTokens);
  const cacheWrite = safe(cacheWriteTokens);
  const promptTokens = input + cacheRead + cacheWrite;
  return {
    promptTokens,
    uncachedTokens: input + cacheWrite,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    hitRate: promptTokens > 0 ? cacheRead / promptTokens : undefined,
  };
}

export type RuntimeSummaryKind = "compaction" | "branch_summary";
export type RuntimeSummaryStatus = "running" | "succeeded" | "failed" | "aborted";

export interface RuntimeSummaryUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost?: number;
}

export interface RuntimeSummaryEvent {
  id: string;
  kind: RuntimeSummaryKind;
  status: RuntimeSummaryStatus;
  timestamp: number;
  active: boolean;
  reason?: "manual" | "threshold" | "overflow";
  summary?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  firstKeptEntryId?: string;
  fromId?: string;
  usage?: RuntimeSummaryUsage;
  readFiles?: string[];
  modifiedFiles?: string[];
  error?: string;
  willRetry?: boolean;
  retryAttempt?: number;
  retryMaxAttempts?: number;
}

export interface RuntimeInspectionSnapshot {
  sessionRevision: number;
  activeLeafId?: string;
  summaryEvents: RuntimeSummaryEvent[];
  effectiveSystemPrompt?: string;
  systemPromptOverride: boolean;
  estimates: {
    systemPrompt?: number;
    toolDefinitions?: number;
    messages?: number;
    total?: number;
  };
  /** Cache-read share of the latest completed model request, not a lifetime average. */
  cacheHitRate?: number;
  tools: RuntimeToolDefinition[];
  skills: RuntimeSkillState[];
  mcp?: McpRuntimeStatus;
  memory?: ProjectMemoryRuntimeStatus;
  capabilities: {
    editSystemPrompt: boolean;
    removeOriginalSessionItems: false;
    removeOriginalSessionItemsReason: string;
  };
}

export interface RuntimeToolDefinition {
  name: string;
  description: string;
  source: string;
  active: boolean;
  estimatedTokens: number;
}

export interface RuntimeSkillState {
  name: string;
  description: string;
  filePath: string;
  source: SkillSource;
  globallyEnabled: boolean;
  sessionEnabled: boolean;
  publishedToModel: boolean;
  readInSession: boolean;
  estimatedMetadataTokens: number;
}

export interface ProjectMemoryRuntimeStatus {
  cwd: string;
  updatedAt: number;
  attemptId?: string;
  state: "idle" | "running" | "busy" | "succeeded" | "failed" | "disabled";
  source: "startup" | "prompt" | "manual" | "automatic";
  exists: boolean;
  injected: boolean;
  projectRoot?: string;
  projectName?: string;
  memoryFile?: string;
  projectMemoryDir?: string;
  contentChars?: number;
  estimatedTokens?: number;
  content?: string;
  sessionFile?: string;
  processedSessions: string[];
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  message?: string;
  error?: string;
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
  planApproval?: PlanApprovalState;
  refreshedAt: number;
}

export interface SessionSnapshot {
  runtimeId?: string;
  /** Monotonic within one live runtime; prevents an older async snapshot from replacing newer message events. */
  messageRevision?: number;
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
  runtimeInspection: RuntimeInspectionSnapshot;
  running: boolean;
}

export interface RuntimeBootstrap {
  configuration: RuntimeConfiguration;
  activeSession?: SessionSnapshot;
}

/** Returned by `open_workspace`: the session list and the opened/created snapshot in one round trip. */
export interface WorkspaceSnapshot {
  sessions: SessionSummary[];
  snapshot: SessionSnapshot;
}

export type RuntimeCommand =
  | { type: "bootstrap" }
  | { type: "get_configuration" }
  | { type: "get_openai_responses_ws_configuration" }
  | { type: "save_openai_responses_ws_configuration"; input: OpenAIResponsesWsConfigurationInput }
  | { type: "get_model_provider_configuration" }
  | { type: "save_model_provider_configuration"; input: ModelProviderConfigurationInput }
  | { type: "remove_model_provider_configuration"; provider: string }
  | {
      /** Update the default used by future sessions. This never mutates a live session. */
      type: "configure_model";
      provider: string;
      modelId: string;
      thinkingLevel: ThinkingLevel;
      /** SuoCode-private context limit override for this provider/model. */
      contextWindow?: number;
      apiKey?: string;
    }
  | {
      /** Switch one existing, idle session. A runtimeId is required by the server. */
      type: "set_session_model";
      provider: string;
      modelId: string;
      thinkingLevel: ThinkingLevel;
      contextWindow?: number;
    }
  | { type: "remove_provider_auth"; provider: string }
  | { type: "start_model_provider_oauth"; provider: string }
  | { type: "respond_model_provider_oauth"; flowId: string; promptId: string; value: string }
  | { type: "cancel_model_provider_oauth"; flowId: string }
  | { type: "fetch_provider_models"; input: FetchProviderModelsInput }
  | { type: "test_provider_connection"; input: TestProviderConnectionInput }
  | { type: "get_mcp_configuration"; cwd?: string }
  | { type: "get_mcp_json" }
  | { type: "save_mcp_json"; content: string; cwd?: string }
  | { type: "get_mcp_status" }
  | { type: "save_mcp_server"; server: McpServerConfiguration; previousName?: string; cwd?: string }
  | { type: "remove_mcp_server"; name: string; scope?: "global" | "project"; cwd?: string }
  | { type: "set_mcp_server_enabled"; name: string; enabled: boolean; cwd: string }
  | { type: "enable_mcp_imports"; imports: McpImportConfiguration["kind"][]; cwd?: string }
  | { type: "connect_mcp_server"; name: string }
  | { type: "start_mcp_auth"; name: string }
  | { type: "complete_mcp_auth"; name: string; input: string }
  | { type: "logout_mcp_server"; name: string }
  | { type: "get_skill_configuration"; cwd?: string }
  | { type: "set_skill_enabled"; filePath: string; enabled: boolean; cwd?: string }
  | { type: "add_skill_path"; path: string; cwd?: string }
  | { type: "remove_skill_path"; path: string; cwd?: string }
  | { type: "set_enable_skill_commands"; enabled: boolean; cwd?: string }
  | { type: "get_runtime_inspection" }
  | { type: "set_session_system_prompt"; prompt?: string }
  | { type: "set_session_skill_enabled"; filePath: string; enabled: boolean }
  | { type: "set_session_mcp_server_enabled"; name: string; enabled: boolean }
  | { type: "approve_plan"; planId: string; target: PlanExecutionTarget; agent?: string }
  | { type: "reject_plan"; planId: string }
  | { type: "run_memory_now" }
  | { type: "remove_original_session_item"; entryId: string }
  | { type: "stop_subagent"; id: string; background: boolean }
  | { type: "resume_subagent"; id: string }
  | { type: "list_sessions"; cwd: string }
  | { type: "list_archived_sessions"; cwd: string }
  | { type: "archive_session"; cwd: string; sessionPath: string }
  | { type: "restore_session"; cwd: string; sessionPath: string }
  | { type: "rename_session"; cwd: string; sessionPath: string; name: string }
  | { type: "pin_session"; cwd: string; sessionPath: string; pinned: boolean }
  | { type: "fork_session"; cwd: string; sessionPath: string }
  | { type: "create_session"; cwd: string; model?: SessionModelSelection }
  | { type: "open_session"; cwd: string; sessionPath: string }
  | { type: "open_workspace"; cwd: string }
  | { type: "prompt"; text: string; images?: PromptImage[]; clientMessageId?: string }
  | { type: "rewind_prompt"; entryId: string; text: string; images?: PromptImage[]; clientMessageId?: string }
  | { type: "steer"; text: string; images?: PromptImage[]; clientMessageId?: string }
  | { type: "abort" }
  | { type: "refresh_project" }
  | { type: "list_directory"; path: string }
  | { type: "read_file"; path: string; maxBytes?: number };

export type RuntimeEvent =
  | { type: "runtime_ready"; configuration: RuntimeConfiguration }
  | { type: "configuration_updated"; configuration: RuntimeConfiguration }
  | { type: "model_provider_auth_updated"; state: ModelProviderAuthState }
  | { type: "sessions_updated"; cwd: string; sessions: SessionSummary[] }
  | { type: "session_snapshot"; snapshot: SessionSnapshot }
  | { type: "message_started"; message: ChatMessage; revision: number }
  | { type: "message_delta"; id: string; field: "text" | "thinking"; delta: string; revision: number }
  | { type: "message_finished"; message: ChatMessage; revision: number }
  | { type: "message_rejected"; id: string; revision: number }
  | { type: "tool_started"; tool: ToolRun }
  | { type: "tool_updated"; tool: ToolRun }
  | { type: "tool_finished"; tool: ToolRun }
  | { type: "plan_updated"; plan: TodoItem[] }
  | { type: "plan_approval_updated"; plan?: PlanApprovalState }
  | { type: "subagents_updated"; subagents: SubagentActivity[] }
  | { type: "project_updated"; project: ProjectSnapshot }
  | {
      type: "metrics_updated";
      responseMetrics?: ResponseMetrics;
      responseMetricsHistory: ResponseMetrics[];
      contextUsage?: ContextUsage;
      tokenUsage: TokenUsage;
    }
  | { type: "runtime_inspection_updated"; inspection: RuntimeInspectionSnapshot }
  | { type: "runtime_notice"; level: "info" | "success" | "error"; message: string }
  | { type: "run_state"; running: boolean }
  | { type: "runtime_released" }
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

export const SESSION_OPEN_SUPERSEDED_ERROR = "SUOCODE_SESSION_OPEN_SUPERSEDED";
