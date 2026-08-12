import {
  DefaultPackageManager,
  DefaultResourceLoader,
  AuthStorage,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  configureHttpDispatcher,
  createEventBus,
  createAgentSession,
  estimateTokens,
  loadSkills,
  processImage,
  readStoredCredential,
  type AgentSession,
  type AgentSessionEvent,
  type EventBusController,
  type SessionShutdownEvent,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type AuthEvent,
  type AuthPrompt,
  type ApiKeyCredential,
  type Provider,
} from "@earendil-works/pi-ai";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type {
  ChangedFile,
  ChangeStatus,
  ChatMessage,
  OpenAIResponsesWsConfiguration,
  OpenAIResponsesWsConfigurationInput,
  ContextUsage,
  FileNode,
  McpConfigurationSnapshot,
  McpActionResult,
  McpImportConfiguration,
  McpJsonDocument,
  McpRuntimeStatus,
  McpServerConfiguration,
  McpServerRuntimeStatus,
  ModelProviderConfiguration,
  ModelProviderAuthPrompt,
  ModelProviderAuthState,
  ModelProviderConfigurationInput,
  ModelProviderConfigurationSnapshot,
  ModelProviderCredentialConfiguration,
  ModelProviderCredentialField,
  ModelProviderCredentialMethod,
  ModelProviderModelConfiguration,
  ModelProviderSaveResult,
  FetchProviderModelsInput,
  FetchProviderModelsResult,
  TestProviderConnectionInput,
  TestProviderConnectionResult,
  ModelOption,
  PromptImage,
  ProjectSnapshot,
  RuntimeBootstrap,
  RuntimeConfiguration,
  RuntimeEvent,
  RuntimeInspectionSnapshot,
  RuntimeSkillState,
  RuntimeToolDefinition,
  RuntimeSummaryEvent,
  ProjectMemoryRuntimeStatus,
  PlanApprovalState,
  PlanExecutionTarget,
  ResponseMetrics,
  SessionModelSelection,
  SessionSnapshot,
  SessionSummary,
  SkillConfigurationSnapshot,
  SkillDiagnostic,
  SkillEntry,
  SkillSource,
  SubagentActivity,
  SubagentTimelineEntry,
  TerminalRun,
  ThinkingLevel,
  TokenUsage,
  TodoItem,
  ToolRun,
} from "@suocode/runtime-protocol";
import { validateMcpJsonText } from "@suocode/runtime-protocol";
import { buildRuntimeInspection, summaryEventFromEntry } from "./runtime-inspection.js";
import {
  DEFAULT_OPENAI_RESPONSES_WS_BASE_URL,
  LEGACY_CLIPROXYAPI_CONFIG_FILE,
  OPENAI_RESPONSES_WS_API,
  OPENAI_RESPONSES_WS_CONFIG_FILE,
  OPENAI_RESPONSES_WS_PROVIDER_ID,
  OPENAI_RESPONSES_WS_PROVIDER_NAME,
} from "@suocode/openai-responses-ws/config";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
const PROJECT_MEMORY_STATUS_EVENT = "suocode:project-memory:status:v1";
const RUNTIME_BRIDGE_COMMAND_EVENT = "suocode:runtime-bridge:command:v1";
const RUNTIME_BRIDGE_REPLY_PREFIX = "suocode:runtime-bridge:reply:v1:";
const RUNTIME_BRIDGE_STATE_EVENT = "suocode:runtime-bridge:state:v1";
const ORIGINAL_SESSION_MUTATION_UNSUPPORTED = "Pi 当前无法安全地从原会话中删除这段历史内容，未执行任何修改。";
const projectMemoryStatusByCwd = new Map<string, ProjectMemoryRuntimeStatus>();
const SUBAGENT_ACTIVITY_CHANNEL = "suocode:subagents:activity:v1";
const SUBAGENT_RPC_REQUEST_CHANNEL = "suocode:subagents:rpc:v1:request";
const SUBAGENT_RUN_ENTRY_TYPE = "subagent-run";
const PLAN_STATE_CHANNEL = "suocode:plan:state:v1";
const PLAN_RPC_REQUEST_CHANNEL = "suocode:plan:rpc:v1:request";
const PLAN_ENTRY_TYPE = "suocode-plan";
const WORKFLOW_PURPOSE_REGISTRY = Symbol.for("suocode-workflow.tool-purpose-registry");
const MCP_AGENT_CONFIG_REGISTRY = Symbol.for("suocode-workflow.mcp-agent-config-registry");
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

export interface McpAdapterEffectiveConfig {
  imports?: McpImportConfiguration["kind"][];
  mcpServers: Record<string, Record<string, unknown>>;
  settings?: Record<string, unknown>;
}

interface McpAdapterConfigModule {
  ensureCompatibilityImports(imports: McpImportConfiguration["kind"][], overridePath?: string): { path: string; added: McpImportConfiguration["kind"][] };
  getMcpDiscoverySummary(overridePath?: string, cwd?: string): {
    imports: Array<{ kind: McpImportConfiguration["kind"]; path: string; serverCount: number }>;
  };
  getPiGlobalConfigPath(overridePath?: string): string;
  getProjectPiConfigPath(cwd?: string): string;
  getServerProvenance(overridePath?: string, cwd?: string): Map<string, { path: string; kind: "user" | "project" | "import"; importKind?: string }>;
  loadMcpConfig(overridePath?: string, cwd?: string): McpAdapterEffectiveConfig;
  writeSharedServerEntry(path: string, serverName: string, entry: Record<string, unknown>): string;
  writeProjectServerDisabledOverride(overridePath: string | undefined, cwd: string, serverName: string, disabled: boolean): { path: string; changed: boolean };
}

function mcpAgentConfigRegistry(): WeakMap<object, McpAdapterEffectiveConfig> {
  const globals = globalThis as Record<PropertyKey, unknown>;
  const existing = globals[MCP_AGENT_CONFIG_REGISTRY];
  if (existing instanceof WeakMap) return existing as WeakMap<object, McpAdapterEffectiveConfig>;
  const registry = new WeakMap<object, McpAdapterEffectiveConfig>();
  globals[MCP_AGENT_CONFIG_REGISTRY] = registry;
  return registry;
}

/**
 * The Settings UI owns the complete MCP configuration. Pi receives a separate
 * capability view containing enabled servers only, so a disabled or deleted
 * server cannot leak through the proxy-tool description, status, search, or
 * direct-tool registration surface.
 */
export function mcpConfigurationForAgent(
  configuration: McpAdapterEffectiveConfig,
  hiddenNames: ReadonlySet<string>,
): McpAdapterEffectiveConfig {
  return {
    ...configuration,
    ...(configuration.imports ? { imports: [...configuration.imports] } : {}),
    ...(configuration.settings ? { settings: { ...configuration.settings } } : {}),
    mcpServers: Object.fromEntries(
      Object.entries(configuration.mcpServers)
        .filter(([name, definition]) => !hiddenNames.has(name) && definition.disabled !== true)
        .map(([name, definition]) => [name, { ...definition }]),
    ),
  };
}

let mcpAdapterConfigModule: Promise<McpAdapterConfigModule> | undefined;

function loadMcpAdapterConfigModule(): Promise<McpAdapterConfigModule> {
  const { createJiti } = require("jiti") as typeof import("jiti");
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  mcpAdapterConfigModule ??= jiti.import(join(resolvePackageDirectory("pi-mcp-adapter"), "config.ts")) as Promise<McpAdapterConfigModule>;
  return mcpAdapterConfigModule;
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const MASKED_CONFIGURATION_VALUE = "••••••";

const MODEL_PROVIDER_APIS: ModelProviderConfigurationSnapshot["supportedApis"] = [
  { id: "openai-completions", label: "OpenAI Chat Completions", description: "兼容性最高，适合绝大多数 OpenAI 兼容服务。" },
  { id: "openai-responses", label: "OpenAI Responses", description: "OpenAI Responses API。" },
  { id: "azure-openai-responses", label: "Azure OpenAI Responses", description: "Azure OpenAI 的 Responses API。" },
  { id: "openai-codex-responses", label: "OpenAI Codex Responses", description: "OpenAI Codex 专用 Responses 流。" },
  { id: "anthropic-messages", label: "Anthropic Messages", description: "Anthropic Claude API 及兼容网关。" },
  { id: "google-generative-ai", label: "Google Generative AI", description: "Google AI Studio / Generative Language API。" },
  { id: "google-vertex", label: "Google Vertex AI", description: "Google Vertex AI。" },
  { id: "mistral-conversations", label: "Mistral Conversations", description: "Mistral 原生 Conversations API。" },
  { id: "bedrock-converse-stream", label: "Amazon Bedrock Converse", description: "Amazon Bedrock Converse Stream API。" },
  { id: "pi-messages", label: "Messages", description: "原生 Messages 流协议，适用于实现该协议的私有服务。" },
  { id: OPENAI_RESPONSES_WS_API, label: OPENAI_RESPONSES_WS_PROVIDER_NAME, description: "SuoCode 的 WebSocket 协议扩展；任何实现该协议的服务都可以直接作为自定义服务商接入，无需 ChatGPT 账号。" },
];

type CredentialFieldDefinition = Omit<ModelProviderCredentialField, "configured" | "value">;
type CredentialMethodDefinition = Omit<ModelProviderCredentialMethod, "fields"> & {
  fields: CredentialFieldDefinition[];
};

const credentialField = (
  id: string,
  label: string,
  input: CredentialFieldDefinition["input"],
  required: boolean,
  placeholder?: string,
  description?: string,
): CredentialFieldDefinition => ({ id, label, input, required, placeholder, description });

const BUILTIN_CREDENTIAL_METHODS: Record<string, CredentialMethodDefinition[]> = {
  "azure-openai-responses": [{
    id: "api-key",
    label: "Azure OpenAI API Key",
    description: "API 密钥负责认证；Azure 端点与资源名决定请求发送到哪里，两者至少填写一项。",
    fields: [
      credentialField("key", "API 密钥", "secret", true, "Azure OpenAI API Key"),
      credentialField("AZURE_OPENAI_BASE_URL", "Azure 端点", "text", false, "https://your-resource.openai.azure.com", "支持 Azure OpenAI、Cognitive Services 与 Azure AI 根地址；会自动规范化为 /openai/v1。"),
      credentialField("AZURE_OPENAI_RESOURCE_NAME", "Azure 资源名", "text", false, "your-resource", "不填写端点时，会由资源名生成 Azure OpenAI 地址。"),
      credentialField("AZURE_OPENAI_API_VERSION", "API 版本", "text", false, "留空使用 v1", "对应 AZURE_OPENAI_API_VERSION。"),
      credentialField("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "模型与部署名映射", "textarea", false, "gpt-4o=my-gpt4o,gpt-5=my-gpt5", "仅当 Azure Deployment 名称与模型 ID 不一致时填写，多个映射使用逗号分隔。"),
    ],
  }],
  "cloudflare-ai-gateway": [{
    id: "api-key",
    label: "Cloudflare AI Gateway",
    description: "对应 Cloudflare AI Gateway 登录流程。三个字段都参与请求认证。",
    fields: [
      credentialField("key", "Cloudflare API Token", "secret", true, "Cloudflare API Token"),
      credentialField("CLOUDFLARE_ACCOUNT_ID", "Account ID", "text", true, "Cloudflare Account ID"),
      credentialField("CLOUDFLARE_GATEWAY_ID", "Gateway ID", "text", true, "AI Gateway slug"),
    ],
  }],
  "cloudflare-workers-ai": [{
    id: "api-key",
    label: "Cloudflare Workers AI",
    description: "对应 Cloudflare Workers AI 登录流程。",
    fields: [
      credentialField("key", "Cloudflare API Token", "secret", true, "Cloudflare API Token"),
      credentialField("CLOUDFLARE_ACCOUNT_ID", "Account ID", "text", true, "Cloudflare Account ID"),
    ],
  }],
  "google-vertex": [
    {
      id: "api-key",
      label: "Google Cloud API Key",
      description: "使用 Vertex Express Mode API Key；不需要 ADC 项目与区域参数。",
      fields: [credentialField("key", "API 密钥", "secret", true, "Google Cloud API Key")],
    },
    {
      id: "adc",
      label: "Application Default Credentials",
      description: "使用 gcloud application-default login 创建的本机 ADC。",
      fields: [
        credentialField("GOOGLE_CLOUD_PROJECT", "Project ID", "text", true, "my-gcp-project"),
        credentialField("GOOGLE_CLOUD_LOCATION", "Location", "text", true, "us-central1"),
      ],
    },
    {
      id: "service-account",
      label: "Service Account 文件",
      description: "使用服务账号 JSON 文件以及明确的项目和区域。",
      fields: [
        credentialField("GOOGLE_APPLICATION_CREDENTIALS", "凭据文件路径", "text", true, "/absolute/path/service-account.json"),
        credentialField("GOOGLE_CLOUD_PROJECT", "Project ID", "text", true, "my-gcp-project"),
        credentialField("GOOGLE_CLOUD_LOCATION", "Location", "text", true, "us-central1"),
      ],
    },
  ],
  "amazon-bedrock": [
    {
      id: "bearer-token",
      label: "Bedrock Bearer Token",
      description: "对应 Bearer token 登录方式。",
      fields: [
        credentialField("key", "Bearer Token", "secret", true, "AWS Bedrock bearer token"),
        credentialField("AWS_REGION", "AWS Region", "text", false, "us-east-1"),
      ],
    },
    {
      id: "aws-profile",
      label: "AWS Profile",
      description: "使用 ~/.aws 中已配置的 Profile；Profile 名称会保存在 SuoCode 私有凭据中。",
      fields: [
        credentialField("AWS_PROFILE", "Profile 名称", "text", true, "default"),
        credentialField("AWS_REGION", "AWS Region", "text", false, "us-east-1"),
      ],
    },
    {
      id: "iam-keys",
      label: "IAM 访问密钥",
      description: "使用 AWS_ACCESS_KEY_ID、AWS_SECRET_ACCESS_KEY 和可选的 Session Token。",
      fields: [
        credentialField("AWS_ACCESS_KEY_ID", "Access Key ID", "secret", true, "AKIA…"),
        credentialField("AWS_SECRET_ACCESS_KEY", "Secret Access Key", "secret", true, "AWS Secret Access Key"),
        credentialField("AWS_SESSION_TOKEN", "Session Token", "secret", false, "临时凭据使用，可选"),
        credentialField("AWS_REGION", "AWS Region", "text", false, "us-east-1"),
      ],
    },
    {
      id: "credential-chain",
      label: "现有 AWS Credential Chain",
      description: "使用运行环境已有的 IAM、ECS Task Role 或 Web Identity 凭据，不在 SuoCode 中保存密钥。",
      fields: [credentialField("AWS_REGION", "AWS Region", "text", false, "us-east-1")],
    },
  ],
};

function selectedCredentialMethod(providerId: string, credential: ApiKeyCredential | undefined): string | undefined {
  const methods = BUILTIN_CREDENTIAL_METHODS[providerId];
  if (!methods?.length) return credential ? "api-key" : undefined;
  if (providerId === "amazon-bedrock") {
    if (credential?.key) return "bearer-token";
    if (credential?.env?.AWS_PROFILE) return "aws-profile";
    if (credential?.env?.AWS_ACCESS_KEY_ID || credential?.env?.AWS_SECRET_ACCESS_KEY) return "iam-keys";
    return credential ? "credential-chain" : methods[0].id;
  }
  if (providerId === "google-vertex") {
    if (credential?.key) return "api-key";
    if (credential?.env?.GOOGLE_APPLICATION_CREDENTIALS) return "service-account";
    if (credential?.env?.GOOGLE_CLOUD_PROJECT || credential?.env?.GOOGLE_CLOUD_LOCATION) return "adc";
  }
  return methods[0].id;
}

function credentialMethodsForProvider(provider: Provider | undefined): CredentialMethodDefinition[] {
  if (!provider?.auth.apiKey) return [];
  return BUILTIN_CREDENTIAL_METHODS[provider.id] ?? [{
    id: "api-key",
    label: provider.auth.apiKey.name || "API 密钥",
    fields: [credentialField("key", provider.auth.apiKey.name || "API 密钥", "secret", true, "粘贴 API 密钥")],
  }];
}

function credentialConfiguration(
  provider: Provider | undefined,
  credential: ApiKeyCredential | undefined,
): ModelProviderCredentialConfiguration {
  const methods = credentialMethodsForProvider(provider);
  return {
    name: provider?.auth.apiKey?.name,
    selectedMethod: selectedCredentialMethod(provider?.id ?? "", credential) ?? methods[0]?.id,
    methods: methods.map((method) => ({
      ...method,
      fields: method.fields.map((field) => {
        const raw = field.id === "key" ? credential?.key : credential?.env?.[field.id];
        return {
          ...field,
          configured: Boolean(raw),
          value: field.input === "secret" ? undefined : raw,
        };
      }),
    })),
    oauth: provider?.auth.oauth ? {
      name: provider.auth.oauth.name,
      label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
    } : undefined,
  };
}

interface PrivateModelsConfiguration {
  providers: Record<string, Record<string, unknown>>;
}

interface ProviderAuthFlow {
  state: ModelProviderAuthState;
  controller: AbortController;
  pendingPrompt?: {
    id: string;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Pi accepts JSON comments in models.json; keep private configurations editable through the GUI. */
function stripJsonComments(value: string): string {
  let output = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];
    if (quoted) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      index += 1;
      while (index + 1 < value.length && value[index + 1] !== "\n" && value[index + 1] !== "\r") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < value.length && !(value[index] === "*" && value[index + 1] === "/")) index += 1;
      if (index < value.length) index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" && record[key].trim() ? record[key] : undefined;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

function optionalPositiveNumber(record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === "number" && Number.isFinite(record[key]) && record[key] > 0 ? record[key] : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringRecord(value: unknown, redact = false): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  if (!entries.length) return undefined;
  return Object.fromEntries(entries.map(([key, entry]) => [key, redact && sensitiveConfigurationKey(key) && entry ? MASKED_CONFIGURATION_VALUE : entry]));
}

function safeUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? cloneJson(value) : undefined;
}

function thinkingLevelMap(value: unknown): Partial<Record<ThinkingLevel, string | null>> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [ThinkingLevel, string | null] =>
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(entry[0])
      && (typeof entry[1] === "string" || entry[1] === null),
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function modelCost(value: unknown): ModelProviderModelConfiguration["cost"] | undefined {
  if (!isRecord(value)) return undefined;
  const input = typeof value.input === "number" ? value.input : undefined;
  const output = typeof value.output === "number" ? value.output : undefined;
  const cacheRead = typeof value.cacheRead === "number" ? value.cacheRead : undefined;
  const cacheWrite = typeof value.cacheWrite === "number" ? value.cacheWrite : undefined;
  const tiers = Array.isArray(value.tiers)
    ? value.tiers.flatMap((tier) => {
      if (!isRecord(tier)) return [];
      const inputTokensAbove = typeof tier.inputTokensAbove === "number" ? tier.inputTokensAbove : undefined;
      const tierInput = typeof tier.input === "number" ? tier.input : undefined;
      const tierOutput = typeof tier.output === "number" ? tier.output : undefined;
      const tierCacheRead = typeof tier.cacheRead === "number" ? tier.cacheRead : undefined;
      const tierCacheWrite = typeof tier.cacheWrite === "number" ? tier.cacheWrite : undefined;
      return inputTokensAbove === undefined || tierInput === undefined || tierOutput === undefined || tierCacheRead === undefined || tierCacheWrite === undefined
        ? []
        : [{ inputTokensAbove, input: tierInput, output: tierOutput, cacheRead: tierCacheRead, cacheWrite: tierCacheWrite }];
    })
    : undefined;
  return input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined
    ? undefined
    : { input, output, cacheRead, cacheWrite, tiers: tiers?.length ? tiers : undefined };
}

function modelConfiguration(value: unknown, fallbackId?: string): ModelProviderModelConfiguration | undefined {
  if (!isRecord(value)) return undefined;
  const id = optionalString(value, "id") ?? fallbackId;
  if (!id) return undefined;
  const input = Array.isArray(value.input)
    ? value.input.filter((item): item is "text" | "image" => item === "text" || item === "image")
    : undefined;
  return {
    id,
    name: optionalString(value, "name"),
    api: optionalString(value, "api"),
    baseUrl: optionalString(value, "baseUrl"),
    reasoning: optionalBoolean(value, "reasoning"),
    thinkingLevelMap: thinkingLevelMap(value.thinkingLevelMap),
    input: input?.length ? input : undefined,
    contextWindow: optionalPositiveNumber(value, "contextWindow"),
    maxTokens: optionalPositiveNumber(value, "maxTokens"),
    cost: modelCost(value.cost),
    samplingParams: safeUnknownRecord(value.samplingParams),
    headers: stringRecord(value.headers, true),
    compat: safeUnknownRecord(value.compat),
  };
}

function modelConfigurationForStorage(
  model: ModelProviderModelConfiguration,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  const headers = mergeMaskedStringRecord(model.headers, objectValue(existing?.headers));
  const result: Record<string, unknown> = {
    id: model.id.trim(),
  };
  const assign = (key: string, value: unknown): void => {
    if (value !== undefined && value !== "") result[key] = value;
  };
  assign("name", model.name?.trim());
  assign("api", model.api?.trim());
  assign("baseUrl", model.baseUrl?.trim());
  assign("reasoning", model.reasoning);
  assign("thinkingLevelMap", model.thinkingLevelMap);
  assign("input", model.input?.length ? model.input : undefined);
  assign("contextWindow", model.contextWindow);
  assign("maxTokens", model.maxTokens);
  assign("cost", model.cost);
  assign("samplingParams", model.samplingParams);
  assign("headers", Object.keys(headers).length ? headers : undefined);
  assign("compat", model.compat);
  return result;
}

function mergeMaskedStringRecord(
  value: Record<string, string> | undefined,
  existing: Record<string, unknown> | undefined,
): Record<string, string> {
  const previous = stringRecord(existing) ?? {};
  return Object.fromEntries(Object.entries(value ?? {}).map(([key, entry]) => [
    key,
    entry === MASKED_CONFIGURATION_VALUE && previous[key] !== undefined ? previous[key] : entry,
  ]));
}

function assertProviderId(value: string): string {
  const id = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw new Error("服务商 ID 只能使用字母、数字、点、短横线或下划线，并且必须以字母或数字开头。");
  }
  return id;
}

function assertOptionalUrl(value: string | undefined, label: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  try {
    const parsed = new URL(normalized);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("Unsupported protocol");
  } catch {
    throw new Error(`${label}必须是完整的 http:// 或 https:// 地址。`);
  }
  return normalized;
}

function isOpenAiCompatibleProviderApi(api: string): boolean {
  return api === "openai-completions" || api === "openai-responses";
}

function joinProviderUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ""), base).toString();
}

/** OpenAI-compatible /models endpoints often live at base or base/v1 regardless of chat protocol. */
function modelListUrlCandidates(baseUrl: string): string[] {
  const normalized = baseUrl.replace(/\/+$/, "");
  const withoutV1 = normalized.replace(/\/v1$/i, "");
  const withV1 = /\/v1$/i.test(normalized) ? normalized : `${withoutV1}/v1`;
  const bases = [...new Set([normalized, withoutV1, withV1].filter(Boolean))];
  return [...new Set(bases.map((base) => joinProviderUrl(base, "models")))];
}

function modelListAuthHeaderVariants(
  baseHeaders: Record<string, string>,
  apiKey: string | undefined,
  api: string | undefined,
): Record<string, string>[] {
  const hasAuth = Object.keys(baseHeaders).some((key) => {
    const lower = key.toLowerCase();
    return lower === "authorization" || lower === "x-api-key";
  });
  if (hasAuth || !apiKey) return [baseHeaders];

  const bearer = { ...baseHeaders, Authorization: `Bearer ${apiKey}` };
  const anthropic = {
    ...baseHeaders,
    "x-api-key": apiKey,
    "anthropic-version": baseHeaders["anthropic-version"] ?? baseHeaders["Anthropic-Version"] ?? "2023-06-01",
  };
  if ((api ?? "").includes("anthropic")) return [anthropic, bearer];
  return [bearer, anthropic];
}

function truncateDetail(value: string, max = 280): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function parseUpstreamModelList(value: unknown): Array<{ id: string; name?: string }> {
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.data)
      ? value.data
      : isRecord(value) && Array.isArray(value.models)
        ? value.models
        : [];
  const models: Array<{ id: string; name?: string }> = [];
  const seen = new Set<string>();
  for (const item of rows) {
    if (typeof item === "string") {
      const id = item.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id });
      continue;
    }
    if (!isRecord(item)) continue;
    const id = optionalString(item, "id") ?? optionalString(item, "name");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = optionalString(item, "name");
    models.push({ id, name: name && name !== id ? name : undefined });
  }
  return models;
}

export interface SuoCodeRuntimeOptions {
  agentDir: string;
  sessionDir: string;
  workflowDir?: string;
  legacyAgentDir?: string;
  modelRuntime?: ModelRuntime;
  modelRuntimePromise?: Promise<ModelRuntime>;
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
  messageRevision: number;
  pendingUserMessageIds: string[];
  activeUserId?: string;
  activeUserOrder?: number;
  lastUserId?: string;
  activeAssistantId?: string;
  activeAssistantOrder?: number;
  activeAssistantMessage?: ChatMessage;
  nextTimelineOrder: number;
  responseMetrics?: ResponseMetrics;
  responseMetricsHistory: ResponseMetrics[];
  sessionRevision: number;
  summaryActivity?: RuntimeSummaryEvent;
  bridgeState?: RuntimeBridgeState;
  memoryStatus?: ProjectMemoryRuntimeStatus;
  skillConfiguration?: SkillConfigurationSnapshot;
  mcpStatus?: McpRuntimeStatus;
  planApproval?: PlanApprovalState;
  eventBus: EventBusController;
}

interface RuntimeBridgeState {
  version: 1;
  effectiveSystemPrompt?: string;
  systemPromptOverride?: string;
  disabledSkills: string[];
  readSkills: string[];
  contextMessages?: unknown[];
  updatedAt: number;
}

interface ReconstructedSessionState {
  messages: ChatMessage[];
  tools: Map<string, ToolRun>;
  subagents: Map<string, SubagentActivity>;
  terminals: Map<string, TerminalRun>;
  plan: TodoItem[];
  nextTimelineOrder: number;
  responseMetrics?: ResponseMetrics;
  responseMetricsHistory: ResponseMetrics[];
  planApproval?: PlanApprovalState;
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

function runtimeBridgeState(value: unknown): RuntimeBridgeState | undefined {
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

function planApprovalState(value: unknown): PlanApprovalState | undefined {
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

function projectMemoryStatus(value: unknown): ProjectMemoryRuntimeStatus | undefined {
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

function hydrateProjectMemoryStatus(status: ProjectMemoryRuntimeStatus): ProjectMemoryRuntimeStatus {
  if (!status.memoryFile || !status.exists || !existsSync(status.memoryFile)) return status;
  try {
    return { ...status, content: readFileSync(status.memoryFile, "utf8") };
  } catch {
    return status;
  }
}

function mergedSessionPaths(...groups: readonly string[][]): string[] {
  return [...new Set(groups.flat().filter(Boolean))];
}

function isWorkspaceMemoryJob(status: ProjectMemoryRuntimeStatus): boolean {
  return status.source === "manual" || status.source === "automatic";
}

function memoryAttemptStartedAt(status: ProjectMemoryRuntimeStatus): number {
  return status.startedAt ?? status.updatedAt;
}

function mergeWorkspaceMemoryStatus(
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

function memoryStatusForInspection(
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

function estimatedTextTokens(value: unknown): number {
  if (typeof value === "string") return Math.ceil(value.length / 4);
  try {
    return Math.ceil(JSON.stringify(value).length / 4);
  } catch {
    return 0;
  }
}

async function shutdownAgentSession(
  session: AgentSession,
  reason: SessionShutdownEvent["reason"] = "quit",
): Promise<void> {
  try {
    await session.abort().catch(() => undefined);
    if (session.extensionRunner.hasHandlers("session_shutdown")) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason });
    }
  } finally {
    session.dispose();
  }
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

function sensitiveConfigurationKey(key: string): boolean {
  return /(?:authorization|api[-_]?key|token|secret|password|cookie|credential)/i.test(key);
}

const MCP_IMPORT_KINDS = new Set<McpImportConfiguration["kind"]>([
  "cursor", "claude-code", "claude-desktop", "codex", "opencode", "windsurf", "vscode",
]);

/** The adapter types `importKind` as a bare string; keep only values we know. */
function mcpImportKind(value: string | undefined): McpImportConfiguration["kind"] | undefined {
  return value && MCP_IMPORT_KINDS.has(value as McpImportConfiguration["kind"])
    ? value as McpImportConfiguration["kind"]
    : undefined;
}

function mcpServerDefinitions(path: string | undefined): Set<string> {
  if (!path || !existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return new Set();
    const rawServers = isRecord(parsed.mcpServers)
      ? parsed.mcpServers
      : isRecord(parsed["mcp-servers"])
        ? parsed["mcp-servers"]
        : {};
    return new Set(Object.entries(rawServers).flatMap(([name, value]) => {
      if (!isRecord(value)) return [];
      return Object.keys(value).some((key) => key !== "disabled") ? [name] : [];
    }));
  } catch {
    return new Set();
  }
}

function redactSensitiveText(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function redactSensitiveValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactSensitiveText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValue(entry, secrets));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSensitiveValue(entry, secrets)]));
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

function subagentActivityStatusFrom(value: unknown): SubagentActivity["status"] {
  if (value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "stopped") return value;
  return "completed";
}

function subagentActivityFromDetails(details: unknown, parentToolId: string): SubagentActivity | undefined {
  if (!isRecord(details)) return undefined;
  const runId = stringValue(details.runId);
  if (!runId) return undefined;
  const usage = isRecord(details.usage) ? details.usage : undefined;
  const tokens = usage && typeof usage.total === "number" && Number.isFinite(usage.total) ? usage.total : 0;
  const turnCount = usage && typeof usage.turns === "number" && Number.isFinite(usage.turns) ? usage.turns : undefined;
  const finalOutput = stringValue(details.finalOutput);
  return {
    id: runId,
    runId,
    parentToolId,
    index: 0,
    agent: stringValue(details.agent) || "子 Agent",
    task: stringValue(details.task) || undefined,
    model: stringValue(details.model) || undefined,
    status: subagentActivityStatusFrom(details.status),
    background: details.background === true,
    controlReady: details.status === "running",
    resumable: details.resumable === true || undefined,
    finalOutput: finalOutput ? clampText(finalOutput, 48_000) : undefined,
    sessionFile: stringValue(details.sessionFile) || undefined,
    worktreePath: stringValue(details.worktreePath) || undefined,
    toolCount: typeof details.toolCount === "number" && Number.isFinite(details.toolCount) ? details.toolCount : 0,
    turnCount,
    tokens,
    durationMs: typeof details.durationMs === "number" && Number.isFinite(details.durationMs) ? details.durationMs : 0,
    error: stringValue(details.error) || undefined,
    updatedAt: Date.now(),
    planId: stringValue(details.planId) || undefined,
  };
}

function subagentActivitiesFromPayload(raw: unknown): SubagentActivity[] {
  if (!isRecord(raw) || !Array.isArray(raw.activities)) return [];
  return raw.activities.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const runId = stringValue(entry.runId);
    if (!runId) return [];
    const recentTools = Array.isArray(entry.recentTools)
      ? entry.recentTools.flatMap((item) => isRecord(item) && stringValue(item.tool) ? [{ tool: stringValue(item.tool), args: stringValue(item.args) }] : [])
      : undefined;
    const recentOutput = Array.isArray(entry.recentOutput)
      ? entry.recentOutput.filter((item): item is string => typeof item === "string")
      : undefined;
    const messages = Array.isArray(entry.messages)
      ? entry.messages.flatMap((item) => isRecord(item) && stringValue(item.text) ? [{ role: stringValue(item.role) || "assistant", text: stringValue(item.text), thinking: stringValue(item.thinking) || undefined }] : [])
      : undefined;
    const toolCalls = Array.isArray(entry.toolCalls)
      ? entry.toolCalls.flatMap((item) => isRecord(item) && stringValue(item.text) ? [{ text: stringValue(item.text), expandedText: stringValue(item.expandedText) || undefined }] : [])
      : undefined;
    let timeline: SubagentTimelineEntry[] | undefined;
    if (Array.isArray(entry.timeline)) {
      const projected: SubagentTimelineEntry[] = [];
      entry.timeline.forEach((item, fallbackOrder) => {
        if (!isRecord(item)) return;
        const kind = stringValue(item.kind);
        const id = stringValue(item.id);
        const order = typeof item.order === "number" && Number.isFinite(item.order) ? item.order : fallbackOrder;
        if (!id || (kind !== "message" && kind !== "tool")) return;
        if (kind === "message") {
          const text = stringValue(item.text);
          if (!text && !stringValue(item.thinking)) return;
          projected.push({
            id,
            order,
            kind: "message",
            role: stringValue(item.role) || "assistant",
            text,
            thinking: stringValue(item.thinking) || undefined,
          });
          return;
        }
        const status: Extract<SubagentTimelineEntry, { kind: "tool" }>["status"] = item.status === "running" || item.status === "failed" ? item.status : "succeeded";
        projected.push({
          id,
          order,
          kind: "tool",
          tool: stringValue(item.tool) || "tool",
          args: stringValue(item.args),
          expandedArgs: stringValue(item.expandedArgs) || undefined,
          output: stringValue(item.output) || undefined,
          status,
        });
      });
      timeline = projected.length ? projected : undefined;
    }
    const finalOutput = stringValue(entry.finalOutput);
    const activity: SubagentActivity = {
      id: stringValue(entry.id) || runId,
      runId,
      parentToolId: stringValue(entry.parentToolId) || undefined,
      index: typeof entry.index === "number" ? entry.index : 0,
      agent: stringValue(entry.agent) || "子 Agent",
      task: stringValue(entry.task) || undefined,
      model: stringValue(entry.model) || undefined,
      status: subagentActivityStatusFrom(entry.status),
      background: entry.background === true,
      controlReady: entry.controlReady === true || undefined,
      resumable: entry.resumable === true || undefined,
      currentTool: stringValue(entry.currentTool) || undefined,
      currentPath: stringValue(entry.currentPath) || undefined,
      recentTools: recentTools?.length ? recentTools : undefined,
      recentOutput: recentOutput?.length ? recentOutput : undefined,
      messages: messages?.length ? messages : undefined,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      timeline: timeline?.length ? timeline : undefined,
      finalOutput: finalOutput ? clampText(finalOutput, 48_000) : undefined,
      sessionFile: stringValue(entry.sessionFile) || undefined,
      worktreePath: stringValue(entry.worktreePath) || undefined,
      toolCount: typeof entry.toolCount === "number" && Number.isFinite(entry.toolCount) ? entry.toolCount : 0,
      turnCount: typeof entry.turnCount === "number" && Number.isFinite(entry.turnCount) ? entry.turnCount : undefined,
      tokens: typeof entry.tokens === "number" && Number.isFinite(entry.tokens) ? entry.tokens : 0,
      durationMs: typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs) ? entry.durationMs : 0,
      error: stringValue(entry.error) || undefined,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
      planId: stringValue(entry.planId) || undefined,
    };
    return [activity];
  });
}

function restoredSubagentActivity(activity: SubagentActivity): SubagentActivity {
  if (activity.status !== "pending" && activity.status !== "running") return activity;
  const resumable = Boolean(activity.sessionFile && existsSync(activity.sessionFile));
  return {
    ...activity,
    status: "stopped",
    controlReady: false,
    resumable: resumable || undefined,
  };
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
    const provider = stringValue(message.provider);
    const modelId = stringValue(message.model);
    return {
      id,
      order,
      role: "assistant",
      model: provider && modelId ? { provider, id: modelId } : undefined,
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
  const absolute = resolve(path);
  let existing = absolute;
  const missingSegments: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    missingSegments.unshift(basename(existing));
    existing = parent;
  }
  try {
    return resolve(realpathSync(existing), ...missingSegments);
  } catch {
    return absolute;
  }
}

function ensureInside(root: string, path: string): string {
  const resolvedRoot = safeRealPath(root);
  const candidate = isAbsolute(path) ? resolve(path) : resolve(resolvedRoot, path);
  const target = safeRealPath(candidate);
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
    resolvePackageDirectory("@suocode/openai-responses-ws"),
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

function migrateLegacyResponsesWsIdentity(agentDir: string): void {
  const settings = SettingsManager.create(process.cwd(), agentDir);
  if (settings.getDefaultProvider() === "cliproxyapi" && settings.getDefaultModel()) {
    settings.setDefaultModelAndProvider(OPENAI_RESPONSES_WS_PROVIDER_ID, settings.getDefaultModel()!);
  }

  const runtimeOptionsPath = join(agentDir, "model-runtime-options.json");
  if (!existsSync(runtimeOptionsPath)) return;
  try {
    const value = JSON.parse(readFileSync(runtimeOptionsPath, "utf8")) as Record<string, unknown>;
    if (!isRecord(value) || !isRecord(value.cliproxyapi) || value[OPENAI_RESPONSES_WS_PROVIDER_ID] !== undefined) return;
    value[OPENAI_RESPONSES_WS_PROVIDER_ID] = value.cliproxyapi;
    delete value.cliproxyapi;
    const temporaryPath = `${runtimeOptionsPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, runtimeOptionsPath);
  } catch {
    // A malformed optional override file must not block the runtime from starting.
  }
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
  private modelRuntimePromise?: Promise<ModelRuntime>;
  private active?: ActiveSession;
  private migratedLegacyCredentials = false;
  private projectRefreshTimer?: ReturnType<typeof setTimeout>;
  private mcpReloadTimer?: ReturnType<typeof setTimeout>;
  private resourceReloadTimer?: ReturnType<typeof setTimeout>;
  private runtimeInspectionRefresh?: Promise<void>;
  /** Serializes model mutations with prompts so a request can never observe a half-applied switch. */
  private modelTransition?: Promise<void>;
  /** Covers Pi's async prompt preflight, before isStreaming becomes true. */
  private promptStarting = false;
  private readonly providerAuthFlows = new Map<string, ProviderAuthFlow>();

  constructor(options: SuoCodeRuntimeOptions) {
    // The Pi CLI configures its Undici dispatcher before provider SDKs run.
    // Embedded SDK consumers must do the same or Node's default dispatcher can
    // negotiate HTTP/2 and surface idle stream errors as uncaught exceptions.
    configureHttpDispatcher();
    this.agentDir = resolve(options.agentDir);
    this.sessionDir = resolve(options.sessionDir);
    this.workflowDir = resolveWorkflowDirectory(options.workflowDir);
    const resources = bundledRuntimeResources(this.workflowDir);
    this.extensionPaths = resources.extensions;
    this.skillPaths = resources.skills;
    this.promptPaths = resources.prompts;
    this.emitEvent = options.onEvent ?? (() => undefined);
    this.modelRuntime = options.modelRuntime;
    if (!this.modelRuntime && options.modelRuntimePromise) {
      this.modelRuntimePromise = options.modelRuntimePromise.then((runtime) => {
        this.modelRuntime = runtime;
        return runtime;
      });
    }
    const codingAgentRoot = resolvePackageDirectory("@earendil-works/pi-coding-agent");
    process.env.PI_CODING_AGENT_DIR = this.agentDir;
    process.env.PI_MEMORY_WORKER_ENTRY = join(codingAgentRoot, "dist", "cli.js");
    this.migratedLegacyCredentials = options.legacyAgentDir
      ? seedLegacyConfiguration(this.agentDir, resolve(options.legacyAgentDir))
      : false;
    migrateLegacyResponsesWsIdentity(this.agentDir);
    mkdirSync(this.sessionDir, { recursive: true });
  }

  async initialize(): Promise<RuntimeBootstrap> {
    await this.ready();
    const configuration = await this.getConfiguration();
    this.emitEvent({ type: "runtime_ready", configuration });
    return { configuration, activeSession: this.active ? await this.snapshot() : undefined };
  }

  private async ready(): Promise<ModelRuntime> {
    if (this.modelRuntime) return this.modelRuntime;
    this.modelRuntimePromise ??= ModelRuntime.create({
      authPath: join(this.agentDir, "auth.json"),
      modelsPath: join(this.agentDir, "models.json"),
      allowModelNetwork: false,
    }).then((runtime) => {
      this.modelRuntime = runtime;
      return runtime;
    }).catch((error) => {
      this.modelRuntimePromise = undefined;
      throw error;
    });
    return this.modelRuntimePromise;
  }

  async sharedModelRuntime(): Promise<ModelRuntime> {
    return this.ready();
  }

  /**
   * After models.json / auth changes, rebind the open session's Model snapshot
   * so endpoint and provider metadata match the shared registry (new chats already do).
   */
  refreshSessionModelFromRegistry(): void {
    const active = this.active;
    if (!active) return;
    const current = active.session.model;
    if (!current) return;
    // Context-window overrides are SuoCode runtime metadata rather than Pi
    // registry data. Refreshing such a model would first discard the override
    // and then require setModel(), which appends a false user model-change
    // record. Keep the effective session object until an explicit switch or a
    // reopen can apply both registry metadata and the override atomically.
    if (this.readModelRuntimeOptions()[current.provider]?.[current.id]?.contextWindow) return;
    active.session.refreshModelFromRegistry();
  }

  async getConfiguration(): Promise<RuntimeConfiguration> {
    const modelRuntime = await this.ready();
    const cwd = this.active?.cwd ?? process.cwd();
    const settings = SettingsManager.create(cwd, this.agentDir);
    const providers = new Map(modelRuntime.getProviders().map((provider) => [provider.id, provider.name || provider.id]));
    const disabledProviders = this.disabledProviderIds();
    const configuredProviders = modelRuntime
      .getProviders()
      .filter((provider) => modelRuntime.hasConfiguredAuth(provider.id) && !disabledProviders.has(provider.id))
      .map((provider) => provider.id)
      .sort();
    const configuredSet = new Set(configuredProviders);
    const runtimeOptions = this.readModelRuntimeOptions();
    const models: ModelOption[] = modelRuntime
      .getModels()
      .filter((model) => !disabledProviders.has(model.provider))
      .map((model) => ({
        provider: model.provider,
        providerName: providers.get(model.provider) ?? model.provider,
        id: model.id,
        name: model.name || model.id,
        reasoning: Boolean(model.reasoning),
        supportsImages: model.input.includes("image"),
        supportedThinkingLevels: getSupportedThinkingLevels(model) as ThinkingLevel[],
        contextWindow: runtimeOptions[model.provider]?.[model.id]?.contextWindow
          ?? (typeof model.contextWindow === "number" ? model.contextWindow : undefined),
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

  private openAIResponsesWsConfigurationPath(): string {
    return join(this.agentDir, OPENAI_RESPONSES_WS_CONFIG_FILE);
  }

  private modelRuntimeOptionsPath(): string {
    return join(this.agentDir, "model-runtime-options.json");
  }

  private readModelRuntimeOptions(): Record<string, Record<string, { contextWindow?: number }>> {
    const path = this.modelRuntimeOptionsPath();
    if (!existsSync(path)) return {};
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isRecord(value)) return {};
      const result: Record<string, Record<string, { contextWindow?: number }>> = {};
      for (const [provider, models] of Object.entries(value)) {
        if (!isRecord(models)) continue;
        result[provider] = {};
        for (const [modelId, options] of Object.entries(models)) {
          if (!isRecord(options)) continue;
          const contextWindow = typeof options.contextWindow === "number" && Number.isFinite(options.contextWindow) && options.contextWindow > 0
            ? Math.round(options.contextWindow)
            : undefined;
          if (contextWindow) result[provider][modelId] = { contextWindow };
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  private writeModelRuntimeContextWindow(provider: string, modelId: string, contextWindow: number): void {
    const values = this.readModelRuntimeOptions();
    values[provider] ??= {};
    values[provider][modelId] = { ...(values[provider][modelId] ?? {}), contextWindow };
    const path = this.modelRuntimeOptionsPath();
    const temporaryPath = `${path}.${process.pid}.tmp`;
    mkdirSync(this.agentDir, { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(values, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  }

  private modelWithRuntimeOptions<T extends { provider: string; id: string; contextWindow: number }>(model: T): T {
    const contextWindow = this.readModelRuntimeOptions()[model.provider]?.[model.id]?.contextWindow;
    return contextWindow && contextWindow !== model.contextWindow ? { ...model, contextWindow } : model;
  }

  private readOpenAIResponsesWsConfigurationFile(): Record<string, unknown> {
    const path = this.openAIResponsesWsConfigurationPath();
    const legacyPath = join(this.agentDir, LEGACY_CLIPROXYAPI_CONFIG_FILE);
    const sourcePath = existsSync(path) ? path : legacyPath;
    if (!existsSync(sourcePath)) return {};
    try {
      const value: unknown = JSON.parse(readFileSync(sourcePath, "utf8"));
      if (!isRecord(value)) throw new Error("配置文件必须包含 JSON 对象。");
      return value;
    } catch (error) {
      throw new Error(`无法读取 OpenAI Response (WS) 配置：${errorMessage(error)}`);
    }
  }

  async getOpenAIResponsesWsConfiguration(): Promise<OpenAIResponsesWsConfiguration> {
    const value = this.readOpenAIResponsesWsConfigurationFile();
    return {
      configPath: this.openAIResponsesWsConfigurationPath(),
      baseUrl: optionalString(value, "baseUrl") ?? DEFAULT_OPENAI_RESPONSES_WS_BASE_URL,
      apiKeyConfigured: Boolean(optionalString(value, "apiKey")),
      fast: optionalBoolean(value, "fast") ?? false,
    };
  }

  async saveOpenAIResponsesWsConfiguration(input: OpenAIResponsesWsConfigurationInput): Promise<RuntimeConfiguration> {
    const baseUrl = assertOptionalUrl(input.baseUrl, "OpenAI Response (WS) Base URL");
    if (!baseUrl) throw new Error("OpenAI Response (WS) Base URL 不能为空。");
    const existing = this.readOpenAIResponsesWsConfigurationFile();
    const apiKey = input.apiKey?.trim() || (input.preserveApiKey ? optionalString(existing, "apiKey") : undefined);
    if (!apiKey) throw new Error("OpenAI Response (WS) API Key 不能为空。");
    const value = {
      baseUrl,
      apiKey,
      fast: input.fast === true,
    };
    mkdirSync(this.agentDir, { recursive: true });
    const path = this.openAIResponsesWsConfigurationPath();
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
    try { chmodSync(path, 0o600); } catch { /* Non-POSIX filesystems can ignore private modes. */ }

    if (this.active) {
      if (this.canReloadActiveSession(this.active)) {
        await this.refreshAgentMcpConfiguration(this.active.eventBus, this.active.cwd);
        await this.active.session.reload();
      }
      else this.reloadActiveSessionResources("OpenAI Response (WS) 配置重新加载失败");
    }
    const configuration = await this.getConfiguration();
    this.emitEvent({ type: "configuration_updated", configuration });
    return configuration;
  }

  private disabledProviderIds(): Set<string> {
    const privateConfiguration = this.readPrivateModelsConfiguration();
    return new Set(
      Object.entries(privateConfiguration.providers)
        .filter(([, provider]) => provider.disabled === true)
        .map(([id]) => id),
    );
  }

  private modelsConfigurationPath(): string {
    return join(this.agentDir, "models.json");
  }

  private readPrivateModelsConfiguration(): PrivateModelsConfiguration {
    const path = this.modelsConfigurationPath();
    if (!existsSync(path)) return { providers: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
    } catch (error) {
      throw new Error(`无法读取 SuoCode 私有 models.json：${errorMessage(error)}`);
    }
    if (!isRecord(parsed) || !isRecord(parsed.providers)) {
      throw new Error("SuoCode 私有 models.json 必须包含 providers 对象。");
    }
    const providers = Object.fromEntries(
      Object.entries(parsed.providers).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])),
    );
    return { providers: cloneJson(providers) };
  }

  private writePrivateModelsConfiguration(configuration: PrivateModelsConfiguration): void {
    mkdirSync(this.agentDir, { recursive: true });
    const path = this.modelsConfigurationPath();
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(configuration, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // A private runtime still works when a filesystem does not support POSIX permissions.
    }
  }

  private modelProviderFromConfiguration(
    providerId: string,
    provider: Record<string, unknown> | undefined,
    runtimeModels: readonly { id: string; name?: string; api?: string; baseUrl?: string; reasoning?: boolean; input: readonly string[]; contextWindow?: number; maxTokens?: number; thinkingLevelMap?: Record<string, string | null | undefined>; cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; tiers?: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }> }; samplingParams?: Record<string, unknown>; headers?: Record<string, string>; compat?: object }[],
    runtimeProvider: Provider | undefined,
    builtins: ReadonlySet<string>,
    modelRuntime: ModelRuntime,
  ): ModelProviderConfiguration {
    const configuredModels = Array.isArray(provider?.models)
      ? provider.models.map((item) => modelConfiguration(item)).filter((item): item is ModelProviderModelConfiguration => Boolean(item))
      : runtimeModels.map((model) => ({
        id: model.id,
        name: model.name,
        api: model.api,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        thinkingLevelMap: thinkingLevelMap(model.thinkingLevelMap),
        input: model.input.filter((item): item is "text" | "image" => item === "text" || item === "image"),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        cost: model.cost && typeof model.cost.input === "number" && typeof model.cost.output === "number" && typeof model.cost.cacheRead === "number" && typeof model.cost.cacheWrite === "number"
          ? { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite, tiers: model.cost.tiers?.map((tier) => ({ ...tier })) }
          : undefined,
        samplingParams: model.samplingParams ? cloneJson(model.samplingParams) : undefined,
        headers: model.headers ? stringRecord(model.headers, true) : undefined,
        compat: safeUnknownRecord(model.compat),
      }));
    const modelOverrides = objectValue(provider?.modelOverrides);
    const mappedOverrides = modelOverrides
      ? Object.fromEntries(Object.entries(modelOverrides).flatMap(([modelId, value]) => {
        const model = modelConfiguration(value, modelId);
        if (!model) return [];
        const { id: _id, api: _api, baseUrl: _baseUrl, ...override } = model;
        return [[modelId, override]];
      })) as ModelProviderConfiguration["modelOverrides"]
      : undefined;
    const apiKey = provider ? optionalString(provider, "apiKey") : undefined;
    const apiKeyReference = apiKey?.startsWith("$") || apiKey?.startsWith("!") ? apiKey : undefined;
    const storedCredential = readStoredCredential(providerId, join(this.agentDir, "auth.json"));
    const storedApiKeyCredential = storedCredential?.type === "api_key" ? storedCredential : undefined;
    const authType = storedCredential?.type
      ?? (modelRuntime.isUsingOAuth(providerId)
        ? "oauth"
        : modelRuntime.hasConfiguredAuth(providerId) || Boolean(apiKey)
          ? "api_key"
          : undefined);
    const providerName = runtimeProvider?.name;
    const fallbackName = providerId === OPENAI_RESPONSES_WS_PROVIDER_ID ? OPENAI_RESPONSES_WS_PROVIDER_NAME : providerId;
    return {
      id: providerId,
      name: provider ? optionalString(provider, "name") ?? providerName ?? fallbackName : providerName ?? fallbackName,
      baseUrl: provider ? optionalString(provider, "baseUrl") : undefined,
      api: provider ? optionalString(provider, "api") : undefined,
      oauth: provider?.oauth === "radius" ? "radius" : undefined,
      headers: provider ? stringRecord(provider.headers, true) : undefined,
      compat: provider ? safeUnknownRecord(provider.compat) : undefined,
      authHeader: provider ? optionalBoolean(provider, "authHeader") : undefined,
      apiKeyReference,
      hasPrivateApiKeyReference: Boolean(apiKey && !apiKeyReference),
      apiKeyConfigured: modelRuntime.hasConfiguredAuth(providerId) || Boolean(apiKey),
      authType,
      disabled: provider?.disabled === true,
      credential: credentialConfiguration(runtimeProvider, storedApiKeyCredential),
      replaceModels: Array.isArray(provider?.models),
      models: configuredModels,
      modelOverrides: mappedOverrides && Object.keys(mappedOverrides).length ? mappedOverrides : undefined,
      source: provider ? builtins.has(providerId) ? "override" : "custom" : "built-in",
    };
  }

  async getModelProviderConfiguration(): Promise<ModelProviderConfigurationSnapshot> {
    const modelRuntime = await this.ready();
    const privateConfiguration = this.readPrivateModelsConfiguration();
    const builtinIds = new Set<string>([...getBuiltinProviders(), "radius", OPENAI_RESPONSES_WS_PROVIDER_ID]);
    const providers = new Map(modelRuntime.getProviders().map((provider) => [provider.id, provider]));
    const allModels = modelRuntime.getModels();
    const models = new Map<string, Array<(typeof allModels)[number]>>();
    for (const model of modelRuntime.getModels()) {
      const values = models.get(model.provider) ?? [];
      values.push(model);
      models.set(model.provider, values);
    }
    const ids = new Set([...providers.keys(), ...Object.keys(privateConfiguration.providers), OPENAI_RESPONSES_WS_PROVIDER_ID]);
    const configuration = [...ids].map((id) => this.modelProviderFromConfiguration(
      id,
      privateConfiguration.providers[id],
      models.get(id) ?? [],
      providers.get(id),
      builtinIds,
      modelRuntime,
    )).sort((left, right) => {
      const rank = (source: ModelProviderConfiguration["source"]): number => source === "custom" ? 0 : source === "override" ? 1 : 2;
      return rank(left.source) - rank(right.source) || Number(right.apiKeyConfigured) - Number(left.apiKeyConfigured) || left.name!.localeCompare(right.name!);
    });
    return {
      configPath: this.modelsConfigurationPath(),
      providers: configuration,
      supportedApis: MODEL_PROVIDER_APIS,
    };
  }

  private validateModelProviderConfiguration(
    input: ModelProviderConfigurationInput,
    existing: Record<string, unknown> | undefined,
    builtinIds: ReadonlySet<string>,
  ): { id: string; provider: Record<string, unknown>; writeModelsConfig: boolean } {
    const draft = input.provider;
    const id = assertProviderId(draft.id);
    const isBuiltin = builtinIds.has(id);
    const baseUrl = assertOptionalUrl(draft.baseUrl, "Base URL");
    const api = draft.api?.trim() || undefined;
    const knownApis = new Set(MODEL_PROVIDER_APIS.map((option) => option.id));
    if (api && !knownApis.has(api)) throw new Error(`“${api}”不是当前支持的请求协议。`);
    if (draft.oauth && draft.oauth !== "radius") throw new Error("当前仅支持 radius OAuth 服务商。");

    const seenModelIds = new Set<string>();
    const models = draft.models.map((model) => {
      const modelId = model.id.trim();
      if (!modelId) throw new Error("每个模型都需要模型 ID。`id` 会原样发送给服务商。");
      if (seenModelIds.has(modelId)) throw new Error(`模型 ID “${modelId}”重复。`);
      seenModelIds.add(modelId);
      const modelApi = model.api?.trim();
      if (modelApi && !knownApis.has(modelApi)) throw new Error(`模型 ${modelId} 使用了不支持的请求协议“${modelApi}”。`);
      assertOptionalUrl(model.baseUrl, `模型 ${modelId} 的 Base URL`);
      if (model.input?.length && !model.input.includes("text")) throw new Error(`模型 ${modelId} 至少需要支持文本输入。`);
      for (const [label, value] of [["上下文窗口", model.contextWindow], ["最大输出", model.maxTokens]] as const) {
        if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`模型 ${modelId} 的${label}必须是大于 0 的数字。`);
      }
      if (model.cost && [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].some((value) => !Number.isFinite(value) || value < 0)) {
        throw new Error(`模型 ${modelId} 的成本参数必须是非负数字。`);
      }
      if (model.cost?.tiers?.some((tier) => !Number.isFinite(tier.inputTokensAbove) || tier.inputTokensAbove < 0 || [tier.input, tier.output, tier.cacheRead, tier.cacheWrite].some((value) => !Number.isFinite(value) || value < 0))) {
        throw new Error(`模型 ${modelId} 的成本阶梯参数必须是非负数字。`);
      }
      return model;
    });
    const isCustom = !isBuiltin && (!existing || !builtinIds.has(id));
    if (isCustom) {
      if (!baseUrl) throw new Error("自定义服务商需要 Base URL。");
      if (!api) throw new Error("自定义服务商需要选择请求协议。");
      if (!draft.replaceModels || !models.length) throw new Error("自定义服务商至少需要定义一个模型。`models` 是识别新服务商的必填目录。");
    }
    const apiKeyReference = draft.apiKeyReference?.trim();
    if (apiKeyReference && !apiKeyReference.startsWith("$") && !apiKeyReference.startsWith("!")) {
      throw new Error("API Key 引用应使用 $环境变量、${环境变量} 或 !命令。普通密钥请填写在私有 API 密钥输入框中。");
    }

    const providerHeaders = mergeMaskedStringRecord(draft.headers, objectValue(existing?.headers));
    const providerCompat = draft.compat && Object.keys(draft.compat).length ? draft.compat : undefined;
    const modelOverrides = draft.modelOverrides && Object.keys(draft.modelOverrides).length ? draft.modelOverrides : undefined;
    const disabled = draft.disabled === true;
    const hasBuiltinOverride = Boolean(
      baseUrl
      || api
      || draft.oauth
      || Object.keys(providerHeaders).length
      || providerCompat
      || draft.authHeader !== undefined
      || draft.replaceModels
      || modelOverrides
      || disabled
      || existing?.disabled === true,
    );

    // A native provider credential save must stay auth.json-only. Provider
    // endpoint/catalog overrides still belong in models.json when the user
    // explicitly configures them under the advanced options.
    if (isBuiltin && !existing && !hasBuiltinOverride) {
      return {
        id,
        provider: apiKeyReference ? { apiKey: apiKeyReference } : {},
        writeModelsConfig: Boolean(apiKeyReference),
      };
    }

    const result: Record<string, unknown> = { ...cloneJson(existing ?? {}) };
    for (const key of ["name", "baseUrl", "api", "oauth", "headers", "compat", "authHeader", "models", "modelOverrides", "disabled"]) delete result[key];
    const set = (key: string, value: unknown): void => {
      if (value !== undefined && value !== "") result[key] = value;
    };
    if (!isBuiltin || existing?.name !== undefined) set("name", draft.name?.trim());
    set("baseUrl", baseUrl);
    set("api", api);
    set("oauth", draft.oauth);
    set("headers", Object.keys(providerHeaders).length ? providerHeaders : undefined);
    set("compat", providerCompat);
    set("authHeader", draft.authHeader);
    if (disabled) result.disabled = true;
    if (apiKeyReference) result.apiKey = apiKeyReference;
    else if (!input.preserveApiKeyReference) delete result.apiKey;
    if (draft.replaceModels) {
      const existingModels = Array.isArray(existing?.models) ? existing.models.filter(isRecord) : [];
      result.models = models.map((model) => modelConfigurationForStorage(model, existingModels.find((item) => optionalString(item, "id") === model.id)));
    }
    set("modelOverrides", modelOverrides);
    return {
      id,
      provider: result,
      writeModelsConfig: !isBuiltin || Boolean(existing) || Object.keys(result).length > 0,
    };
  }

  private async saveProviderCredential(
    providerId: string,
    input: ModelProviderConfigurationInput,
    modelRuntime: ModelRuntime,
  ): Promise<void> {
    const legacyKey = input.apiKey?.trim();
    if (!input.credential && !legacyKey) return;

    const runtimeProvider = modelRuntime.getProviders().find((provider) => provider.id === providerId);
    if (!runtimeProvider?.auth.apiKey) throw new Error(`服务商 ${providerId} 不支持 API Key 或凭据配置。`);
    const methods = credentialMethodsForProvider(runtimeProvider);
    if (!methods.length) throw new Error(`服务商 ${providerId} 没有可用的 API Key 配置方式。`);

    const credentialInput = input.credential ?? {
      method: methods[0].id,
      values: { key: legacyKey ?? "" },
      preserveFields: [],
    };
    const method = methods.find((item) => item.id === credentialInput.method);
    if (!method) throw new Error(`“${credentialInput.method}”不是 ${runtimeProvider.name} 支持的凭据方式。`);

    const current = readStoredCredential(providerId, join(this.agentDir, "auth.json"));
    const currentApiKey = current?.type === "api_key" ? current : undefined;
    const preserve = new Set(credentialInput.preserveFields);
    const values = Object.fromEntries(Object.entries(credentialInput.values).map(([key, value]) => [key, value.trim()]));
    const knownEnvironmentFields = new Set(methods.flatMap((item) => item.fields.map((field) => field.id)).filter((id) => id !== "key"));
    const env = { ...(currentApiKey?.env ?? {}) };
    for (const field of knownEnvironmentFields) delete env[field];

    let key: string | undefined;
    for (const field of method.fields) {
      const submitted = values[field.id];
      const previous = field.id === "key" ? currentApiKey?.key : currentApiKey?.env?.[field.id];
      const value = submitted || (preserve.has(field.id) ? previous : undefined);
      if (field.required && !value) throw new Error(`${runtimeProvider.name} 的“${field.label}”不能为空。`);
      if (!value) continue;
      if (field.id === "key") key = value;
      else env[field.id] = value;
    }

    if (providerId === "azure-openai-responses" && !env.AZURE_OPENAI_BASE_URL && !env.AZURE_OPENAI_RESOURCE_NAME) {
      throw new Error("Azure OpenAI 需要填写 Endpoint / Base URL 或 Resource Name。两者至少填写一项。");
    }

    const credential: ApiKeyCredential = {
      type: "api_key",
      ...(key ? { key } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    };
    const authStorage = AuthStorage.create(join(this.agentDir, "auth.json"));
    await authStorage.modify(providerId, async () => credential);
    await modelRuntime.refresh({ providers: [providerId], allowNetwork: false });
  }

  async saveModelProviderConfiguration(input: ModelProviderConfigurationInput): Promise<ModelProviderSaveResult> {
    const modelRuntime = await this.ready();
    const privateConfiguration = this.readPrivateModelsConfiguration();
    const builtinIds = new Set<string>([...getBuiltinProviders(), "radius", OPENAI_RESPONSES_WS_PROVIDER_ID]);
    const existing = privateConfiguration.providers[input.provider.id.trim()];
    const next = this.validateModelProviderConfiguration(input, existing, builtinIds);
    if (next.writeModelsConfig) {
      const previous = cloneJson(privateConfiguration);
      const keys = Object.keys(next.provider).filter((key) => key !== "disabled" || next.provider.disabled === true);
      const emptyDisableOnly = builtinIds.has(next.id) && keys.length === 0 && next.provider.disabled !== true;
      if (emptyDisableOnly) delete privateConfiguration.providers[next.id];
      else privateConfiguration.providers[next.id] = next.provider;
      this.writePrivateModelsConfiguration(privateConfiguration);
      try {
        await modelRuntime.refresh({ allowNetwork: false });
        const runtimeError = modelRuntime.getError();
        if (runtimeError?.includes("models.json") || runtimeError?.includes(`Provider \"${next.id}\"`)) throw new Error(runtimeError);
      } catch (error) {
        this.writePrivateModelsConfiguration(previous);
        await modelRuntime.refresh({ allowNetwork: false });
        throw new Error(`无法应用此服务商配置：${errorMessage(error)}`);
      }
    }

    try {
      await this.saveProviderCredential(next.id, input, modelRuntime);
    } catch (error) {
      throw new Error(`服务商配置已保存，但无法保存凭据：${errorMessage(error)}`);
    }

    const configuration = await this.getConfiguration();
    this.emitEvent({ type: "configuration_updated", configuration });
    this.refreshSessionModelFromRegistry();
    const saved = await this.getModelProviderConfiguration();
    const provider = saved.providers.find((item) => item.id === next.id);
    if (!provider) throw new Error("配置已刷新，但未能读取刚保存的服务商。");
    return { provider, configuration };
  }

  async removeModelProviderConfiguration(providerId: string): Promise<RuntimeConfiguration> {
    const id = assertProviderId(providerId);
    const privateConfiguration = this.readPrivateModelsConfiguration();
    const existing = privateConfiguration.providers[id];
    const modelRuntime = await this.ready();
    try {
      await modelRuntime.logout(id);
    } catch {
      // A malformed/removed provider may not expose a logout handler; config removal still proceeds.
    }
    if (existing) {
      delete privateConfiguration.providers[id];
      this.writePrivateModelsConfiguration(privateConfiguration);
      await modelRuntime.refresh({ allowNetwork: false });
      const runtimeError = modelRuntime.getError();
      if (runtimeError?.includes("models.json")) throw new Error(`无法重新加载服务商目录：${runtimeError}`);
    } else if (!modelRuntime.hasConfiguredAuth(id)) {
      throw new Error("此服务商没有可移除的配置。");
    }
    const configuration = await this.getConfiguration();
    this.emitEvent({ type: "configuration_updated", configuration });
    this.refreshSessionModelFromRegistry();
    return configuration;
  }

  async configureModel(input: {
    provider: string;
    modelId: string;
    thinkingLevel: ThinkingLevel;
    contextWindow?: number;
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

    if (input.contextWindow !== undefined) {
      if (!Number.isFinite(input.contextWindow) || input.contextWindow < 1_024) {
        throw new Error("上下文窗口必须是不小于 1024 的数字。");
      }
      this.writeModelRuntimeContextWindow(input.provider, input.modelId, Math.round(input.contextWindow));
    }
    const effectiveModel = this.modelWithRuntimeOptions(model);
    const effectiveThinkingLevel = clampThinkingLevel(effectiveModel, input.thinkingLevel) as ThinkingLevel;
    const settings = SettingsManager.create(this.active?.cwd ?? process.cwd(), this.agentDir);
    settings.setDefaultModelAndProvider(input.provider, input.modelId);
    settings.setDefaultThinkingLevel(effectiveThinkingLevel);
    await settings.flush();

    const configuration = await this.getConfiguration();
    this.emitEvent({ type: "configuration_updated", configuration });
    return configuration;
  }

  /**
   * Change the model owned by this live conversation.
   *
   * Pi captures a model when a provider request starts. Mutating it while an
   * Agent run is active only changes the session log; it cannot retarget that
   * already-started request. Refuse that ambiguous state instead of claiming a
   * switch that did not actually happen.
   */
  async setSessionModel(input: {
    provider: string;
    modelId: string;
    thinkingLevel: ThinkingLevel;
    contextWindow?: number;
  }): Promise<RuntimeConfiguration> {
    const active = this.requireActive();
    if (active.session.isStreaming || this.promptStarting) {
      throw new Error("当前 Agent 正在运行。请等待回复结束或先停止，再切换模型。");
    }
    if (this.modelTransition) {
      throw new Error("模型正在切换，请稍候。");
    }

    const transition = (async (): Promise<void> => {
      const modelRuntime = await this.ready();
      const model = modelRuntime.getModel(input.provider, input.modelId);
      if (!model) throw new Error(`Unknown model: ${input.provider}/${input.modelId}`);
      if (!(await modelRuntime.checkAuth(input.provider))) {
        throw new Error(`No credential is configured for ${input.provider}.`);
      }
      if (input.contextWindow !== undefined) {
        if (!Number.isFinite(input.contextWindow) || input.contextWindow < 1_024) {
          throw new Error("上下文窗口必须是不小于 1024 的数字。");
        }
        this.writeModelRuntimeContextWindow(input.provider, input.modelId, Math.round(input.contextWindow));
      }

      const effectiveModel = this.modelWithRuntimeOptions(model);
      const effectiveThinkingLevel = clampThinkingLevel(effectiveModel, input.thinkingLevel) as ThinkingLevel;
      await active.session.setModel(effectiveModel);
      active.session.setThinkingLevel(effectiveThinkingLevel);
      await active.session.settingsManager.flush();

      // setModel and setThinkingLevel are synchronous from the session's point
      // of view; emit only after both are committed so the UI cannot display a
      // mixed provider/model state.
      this.emitEvent({ type: "session_snapshot", snapshot: await this.snapshot() });
    })();
    this.modelTransition = transition;
    try {
      await transition;
    } finally {
      if (this.modelTransition === transition) this.modelTransition = undefined;
    }

    const configuration = await this.getConfiguration();
    this.emitEvent({ type: "configuration_updated", configuration });
    return configuration;
  }

  private publishProviderAuth(flow: ProviderAuthFlow): void {
    this.emitEvent({
      type: "model_provider_auth_updated",
      state: {
        ...flow.state,
        prompt: flow.state.prompt
          ? flow.state.prompt.type === "select"
            ? { ...flow.state.prompt, options: flow.state.prompt.options.map((option) => ({ ...option })) }
            : { ...flow.state.prompt }
          : undefined,
        authUrl: flow.state.authUrl ? { ...flow.state.authUrl } : undefined,
        deviceCode: flow.state.deviceCode ? { ...flow.state.deviceCode } : undefined,
        links: flow.state.links?.map((link) => ({ ...link })),
      },
    });
  }

  private updateProviderAuth(flow: ProviderAuthFlow, patch: Partial<ModelProviderAuthState>): void {
    flow.state = { ...flow.state, ...patch };
    this.publishProviderAuth(flow);
  }

  private clearProviderAuthPrompt(flow: ProviderAuthFlow): ProviderAuthFlow["pendingPrompt"] {
    const pending = flow.pendingPrompt;
    if (!pending) return undefined;
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    flow.pendingPrompt = undefined;
    return pending;
  }

  private waitForProviderAuthPrompt(flow: ProviderAuthFlow, prompt: AuthPrompt): Promise<string> {
    if (flow.controller.signal.aborted) return Promise.reject(new Error("订阅登录已取消。"));
    if (flow.pendingPrompt) return Promise.reject(new Error("订阅登录正在等待上一个输入。"));
    const id = randomUUID();
    const projected: ModelProviderAuthPrompt = prompt.type === "select"
      ? {
          id,
          type: "select",
          message: prompt.message,
          options: prompt.options.map((option) => ({ ...option })),
        }
      : {
          id,
          type: prompt.type,
          message: prompt.message,
          placeholder: prompt.placeholder,
        };
    return new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        if (flow.pendingPrompt?.id !== id) return;
        flow.pendingPrompt = undefined;
        reject(new Error("当前授权输入已失效。"));
      };
      flow.pendingPrompt = { id, resolve, reject, signal: prompt.signal, onAbort };
      prompt.signal?.addEventListener("abort", onAbort, { once: true });
      this.updateProviderAuth(flow, {
        status: "waiting_for_user",
        message: prompt.message,
        prompt: projected,
        error: undefined,
      });
    });
  }

  private handleProviderAuthNotification(flow: ProviderAuthFlow, event: AuthEvent): void {
    if (flow.controller.signal.aborted) return;
    switch (event.type) {
      case "auth_url":
        this.updateProviderAuth(flow, {
          status: flow.pendingPrompt ? "waiting_for_user" : "authorizing",
          message: event.instructions ?? "请在浏览器中完成订阅登录。",
          authUrl: { url: event.url, instructions: event.instructions },
          error: undefined,
        });
        break;
      case "device_code":
        this.updateProviderAuth(flow, {
          status: "authorizing",
          message: "请在浏览器中输入设备验证码，SuoCode 会自动等待授权完成。",
          deviceCode: {
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            expiresInSeconds: event.expiresInSeconds,
          },
          error: undefined,
        });
        break;
      case "info":
        this.updateProviderAuth(flow, {
          status: flow.pendingPrompt ? "waiting_for_user" : "authorizing",
          message: event.message,
          links: event.links?.map((link) => ({ ...link })),
          error: undefined,
        });
        break;
      case "progress":
        this.updateProviderAuth(flow, {
          status: flow.pendingPrompt ? "waiting_for_user" : "authorizing",
          message: event.message,
          error: undefined,
        });
        break;
    }
  }

  async startModelProviderOAuth(providerId: string): Promise<ModelProviderAuthState> {
    const modelRuntime = await this.ready();
    const provider = modelRuntime.getProvider(providerId);
    const oauth = provider?.auth.oauth;
    if (!provider || !oauth) throw new Error("此服务商不支持订阅登录。");
    const existing = [...this.providerAuthFlows.values()].find((flow) => flow.state.provider === providerId);
    if (existing) return existing.state;

    const flow: ProviderAuthFlow = {
      controller: new AbortController(),
      state: {
        flowId: randomUUID(),
        provider: providerId,
        providerName: provider.name,
        loginLabel: oauth.loginLabel ?? oauth.name,
        status: "starting",
        message: "正在准备订阅登录…",
      },
    };
    this.providerAuthFlows.set(flow.state.flowId, flow);
    this.publishProviderAuth(flow);

    void modelRuntime.login(providerId, "oauth", {
      signal: flow.controller.signal,
      prompt: (prompt) => this.waitForProviderAuthPrompt(flow, prompt),
      notify: (event) => this.handleProviderAuthNotification(flow, event),
    }).then(async () => {
      if (this.providerAuthFlows.get(flow.state.flowId) !== flow) return;
      this.clearProviderAuthPrompt(flow);
      this.updateProviderAuth(flow, {
        status: "succeeded",
        message: `${flow.state.providerName} 订阅登录成功。`,
        prompt: undefined,
        error: undefined,
      });
      this.providerAuthFlows.delete(flow.state.flowId);
      try {
        const configuration = await this.getConfiguration();
        this.emitEvent({ type: "configuration_updated", configuration });
        this.refreshSessionModelFromRegistry();
      } catch (error) {
        this.emitEvent({ type: "runtime_error", message: "订阅登录已保存，但模型目录刷新失败。", detail: errorDetail(error) });
      }
    }).catch((error) => {
      if (this.providerAuthFlows.get(flow.state.flowId) !== flow) return;
      this.clearProviderAuthPrompt(flow);
      if (flow.controller.signal.aborted) {
        this.updateProviderAuth(flow, {
          status: "cancelled",
          message: "订阅登录已取消。",
          prompt: undefined,
          error: undefined,
        });
      } else {
        this.updateProviderAuth(flow, {
          status: "failed",
          message: "订阅登录失败。",
          prompt: undefined,
          error: errorMessage(error),
        });
      }
      this.providerAuthFlows.delete(flow.state.flowId);
    });
    return { ...flow.state };
  }

  async respondModelProviderOAuth(flowId: string, promptId: string, value: string): Promise<void> {
    const flow = this.providerAuthFlows.get(flowId);
    if (!flow) throw new Error("这次订阅登录已经结束，请重新发起登录。");
    const pending = flow.pendingPrompt;
    if (!pending || pending.id !== promptId) throw new Error("授权步骤已经变化，请按当前界面继续。");
    this.clearProviderAuthPrompt(flow);
    this.updateProviderAuth(flow, {
      status: "authorizing",
      message: "正在验证授权信息…",
      prompt: undefined,
      error: undefined,
    });
    pending.resolve(value);
  }

  async cancelModelProviderOAuth(flowId: string): Promise<void> {
    const flow = this.providerAuthFlows.get(flowId);
    if (!flow) return;
    const pending = this.clearProviderAuthPrompt(flow);
    flow.controller.abort();
    pending?.reject(new Error("订阅登录已取消。"));
    this.updateProviderAuth(flow, {
      status: "cancelled",
      message: "订阅登录已取消。",
      prompt: undefined,
      error: undefined,
    });
    this.providerAuthFlows.delete(flowId);
  }

  async removeProviderAuth(provider: string): Promise<RuntimeConfiguration> {
    const modelRuntime = await this.ready();
    await modelRuntime.logout(provider);
    const configuration = await this.getConfiguration();
    this.emitEvent({ type: "configuration_updated", configuration });
    this.refreshSessionModelFromRegistry();
    return configuration;
  }

  async fetchProviderModels(input: FetchProviderModelsInput): Promise<FetchProviderModelsResult> {
    const baseUrl = assertOptionalUrl(input.baseUrl, "Base URL");
    if (!baseUrl) throw new Error("拉取模型列表需要 Base URL。");
    // Model list is almost always OpenAI-compatible `/models`, independent of the chat protocol
    // (Anthropic / Gemini / etc.). Try with and without `/v1` so users do not need to flip API + URL.
    const apiKey = await this.resolveProviderApiKey(input.provider, input.apiKey);
    const baseHeaders: Record<string, string> = {
      Accept: "application/json",
      ...(input.headers ?? {}),
    };
    const headerVariants = modelListAuthHeaderVariants(baseHeaders, apiKey, input.api);
    const urls = modelListUrlCandidates(baseUrl);
    const errors: string[] = [];

    for (const url of urls) {
      for (const headers of headerVariants) {
        try {
          const response = await fetch(url, { method: "GET", headers });
          const text = await response.text();
          if (!response.ok) {
            errors.push(`${url} → HTTP ${response.status}: ${truncateDetail(text)}`);
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            errors.push(`${url} → 返回的不是 JSON：${truncateDetail(text)}`);
            continue;
          }
          const models = parseUpstreamModelList(parsed);
          if (!models.length) {
            errors.push(`${url} → 未返回可用模型`);
            continue;
          }
          return { models };
        } catch (error) {
          errors.push(`${url} → ${errorMessage(error)}`);
        }
      }
    }

    const detail = errors.at(-1) ?? "未知错误";
    throw new Error(`拉取模型失败：已自动尝试有/无 /v1 的地址。最后一次：${detail}`);
  }

  async testProviderConnection(input: TestProviderConnectionInput): Promise<TestProviderConnectionResult> {
    const baseUrl = assertOptionalUrl(input.baseUrl, "Base URL");
    if (!baseUrl) throw new Error("测试连接需要 Base URL。");
    const api = input.api.trim();
    if (!isOpenAiCompatibleProviderApi(api)) {
      return { ok: false, message: "当前协议暂不支持一键测试。", detail: "请改用 OpenAI Chat Completions 或 OpenAI Responses。" };
    }
    const apiKey = await this.resolveProviderApiKey(input.provider, input.apiKey);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(input.headers ?? {}),
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
    const modelId = input.modelId?.trim();
    if (!modelId) return { ok: false, message: "请先选择要测试的模型。" };
    try {
      if (api === "openai-responses") {
        const url = joinProviderUrl(baseUrl, "responses");
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: modelId,
            input: "Hello",
            max_output_tokens: 16,
          }),
        });
        const text = await response.text();
        if (!response.ok) return { ok: false, message: `测试失败（HTTP ${response.status}）`, detail: truncateDetail(text) };
        return { ok: true, message: "已收到 Responses 回复。" };
      }
      const url = joinProviderUrl(baseUrl, "chat/completions");
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 16,
        }),
      });
      const text = await response.text();
      if (!response.ok) return { ok: false, message: `测试失败（HTTP ${response.status}）`, detail: truncateDetail(text) };
      return { ok: true, message: "已收到 Chat Completions 回复。" };
    } catch (error) {
      return { ok: false, message: "测试请求失败", detail: errorMessage(error) };
    }
  }

  private async resolveProviderApiKey(providerId: string | undefined, submitted?: string): Promise<string | undefined> {
    const trimmed = submitted?.trim();
    if (trimmed) return trimmed;
    if (!providerId?.trim()) return undefined;
    const stored = readStoredCredential(providerId.trim(), join(this.agentDir, "auth.json"));
    if (stored?.type === "api_key" && stored.key) return stored.key;
    return undefined;
  }

  private mcpCwd(cwd?: string): string {
    return cwd ? safeRealPath(cwd) : this.active?.cwd ?? process.cwd();
  }

  private archivedSessionsPath(): string {
    return join(this.agentDir, "archived-sessions.json");
  }

  private pinnedSessionsPath(): string {
    return join(this.agentDir, "pinned-sessions.json");
  }

  private readArchivedSessions(): Record<string, string> {
    return this.readPathTimestampMap(this.archivedSessionsPath());
  }

  private writeArchivedSessions(value: Record<string, string>): void {
    this.writePathTimestampMap(this.archivedSessionsPath(), value);
  }

  private readPinnedSessions(): Record<string, string> {
    return this.readPathTimestampMap(this.pinnedSessionsPath());
  }

  private writePinnedSessions(value: Record<string, string>): void {
    this.writePathTimestampMap(this.pinnedSessionsPath(), value);
  }

  private readPathTimestampMap(path: string): Record<string, string> {
    if (!existsSync(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return recordOfStrings(parsed);
    } catch {
      return {};
    }
  }

  private writePathTimestampMap(path: string, value: Record<string, string>): void {
    mkdirSync(this.agentDir, { recursive: true });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  }

  private reloadMcpExtension(): void {
    this.reloadActiveSessionResources("MCP 扩展重新加载失败");
  }

  private async refreshAgentMcpConfiguration(eventBus: EventBusController, cwd: string): Promise<void> {
    const adapter = await loadMcpAdapterConfigModule();
    const resolvedCwd = this.mcpCwd(cwd);
    this.cleanRemovedMcpServerState(adapter, resolvedCwd);
    const configPath = adapter.getPiGlobalConfigPath(join(this.agentDir, "mcp.json"));
    const configuration = adapter.loadMcpConfig(configPath, resolvedCwd);
    const hiddenNames = new Set([
      ...this.readRemovedMcpServers(),
      ...this.readDisabledMcpServers(),
    ]);
    mcpAgentConfigRegistry().set(eventBus, mcpConfigurationForAgent(configuration, hiddenNames));
  }

  private async reloadActiveSessionNow(active: ActiveSession): Promise<void> {
    await this.refreshAgentMcpConfiguration(active.eventBus, active.cwd);
    await active.session.reload();
    if (this.active !== active) return;
    this.emitEvent({ type: "session_snapshot", snapshot: await this.snapshot() });
    await this.refreshRuntimeInspectionSources(active);
  }

  private async reloadMcpExtensionNow(): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (!this.canReloadActiveSession(active)) {
      this.reloadMcpExtension();
      return;
    }
    if (this.resourceReloadTimer) clearTimeout(this.resourceReloadTimer);
    this.resourceReloadTimer = undefined;
    await this.reloadActiveSessionNow(active);
  }

  private canReloadActiveSession(active: ActiveSession): boolean {
    if (active.session.isStreaming) return false;
    return ![...active.subagents.values()].some((subagent) =>
      (subagent.status === "pending" || subagent.status === "running") && subagent.controlReady === true,
    );
  }

  private reloadActiveSessionResources(errorLabel = "资源重新加载失败"): void {
    if (this.resourceReloadTimer) clearTimeout(this.resourceReloadTimer);
    if (this.mcpReloadTimer) clearTimeout(this.mcpReloadTimer);
    this.mcpReloadTimer = undefined;
    const active = this.active;
    if (!active) return;
    const attemptReload = (): void => {
      this.resourceReloadTimer = undefined;
      if (this.active !== active) return;
      if (!this.canReloadActiveSession(active)) {
        this.resourceReloadTimer = setTimeout(attemptReload, 750);
        return;
      }
      void this.reloadActiveSessionNow(active)
        .catch((error) => {
          this.emitEvent({ type: "runtime_error", message: `${errorLabel}：${errorMessage(error)}`, detail: errorDetail(error) });
        });
    };
    this.resourceReloadTimer = setTimeout(attemptReload, 750);
  }

  private skillSettingsManager(cwd?: string): SettingsManager {
    return SettingsManager.create(this.mcpCwd(cwd), this.agentDir, { projectTrusted: true });
  }

  private classifySkillSource(
    filePath: string,
    scope: "user" | "project" | "temporary",
    origin: "package" | "top-level",
    source: string,
  ): SkillSource {
    if (origin === "package" || this.skillPaths.some((path) => filePath === path || filePath.startsWith(`${path}${sep}`))) {
      return "bundled";
    }
    if (source === "auto" && filePath.split(sep).includes(".agents")) return "agents";
    if (scope === "project") return "project";
    return "user";
  }

  private plainSkillPathEntries(paths: string[]): string[] {
    return paths.filter((entry) => !entry.startsWith("+") && !entry.startsWith("-") && !entry.startsWith("!"));
  }

  private expandSkillPath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed) throw new Error("技能路径不能为空。");
    if (trimmed === "~") return homedir();
    if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
    return isAbsolute(trimmed) ? resolve(trimmed) : resolve(trimmed);
  }

  private skillOverridePattern(filePath: string, baseDir: string): string {
    const pattern = relative(baseDir, filePath).split(sep).join("/");
    if (!pattern || pattern.startsWith("..")) return filePath;
    return pattern;
  }

  private rewriteSkillOverridePaths(paths: string[], pattern: string, enabled: boolean): string[] {
    const disablePattern = `-${pattern}`;
    const enablePattern = `+${pattern}`;
    const updated = paths.filter((entry) => {
      const stripped = entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-") ? entry.slice(1) : entry;
      return stripped !== pattern;
    });
    updated.push(enabled ? enablePattern : disablePattern);
    return updated;
  }

  async getSkillConfiguration(cwd?: string): Promise<SkillConfigurationSnapshot> {
    const resolvedCwd = this.mcpCwd(cwd);
    const settingsManager = this.skillSettingsManager(resolvedCwd);
    const packageManager = new DefaultPackageManager({
      cwd: resolvedCwd,
      agentDir: this.agentDir,
      settingsManager,
    });
    const resolved = await packageManager.resolve(async () => "skip");
    const diagnostics: SkillDiagnostic[] = [];
    const skills: SkillEntry[] = [];
    const seen = new Set<string>();

    for (const entry of resolved.skills) {
      const loaded = loadSkills({
        cwd: resolvedCwd,
        agentDir: this.agentDir,
        skillPaths: [entry.path],
        includeDefaults: false,
      });
      for (const diagnostic of loaded.diagnostics) {
        diagnostics.push({ type: diagnostic.type, message: diagnostic.message, path: diagnostic.path });
      }
      for (const skill of loaded.skills) {
        if (seen.has(skill.filePath)) continue;
        seen.add(skill.filePath);
        const scope = entry.metadata.scope === "project" ? "project" : "user";
        skills.push({
          name: skill.name,
          description: skill.description,
          filePath: skill.filePath,
          baseDir: skill.baseDir,
          source: this.classifySkillSource(skill.filePath, entry.metadata.scope, entry.metadata.origin, entry.metadata.source),
          enabled: entry.enabled,
          disableModelInvocation: skill.disableModelInvocation,
          scope,
        });
      }
    }

    if (this.skillPaths.length > 0) {
      const bundled = loadSkills({
        cwd: resolvedCwd,
        agentDir: this.agentDir,
        skillPaths: this.skillPaths,
        includeDefaults: false,
      });
      for (const diagnostic of bundled.diagnostics) {
        diagnostics.push({ type: diagnostic.type, message: diagnostic.message, path: diagnostic.path });
      }
      for (const skill of bundled.skills) {
        if (seen.has(skill.filePath)) continue;
        seen.add(skill.filePath);
        skills.push({
          name: skill.name,
          description: skill.description,
          filePath: skill.filePath,
          baseDir: skill.baseDir,
          source: "bundled",
          enabled: true,
          disableModelInvocation: skill.disableModelInvocation,
          scope: "user",
        });
      }
    }

    skills.sort((left, right) => left.name.localeCompare(right.name) || left.filePath.localeCompare(right.filePath));
    const skillPaths = settingsManager.getSkillPaths();
    const projectSkillPaths = [...(settingsManager.getProjectSettings().skills ?? [])];
    return {
      agentDir: this.agentDir,
      userSkillsDir: join(this.agentDir, "skills"),
      projectSkillsDir: join(resolvedCwd, ".pi", "skills"),
      agentsSkillsDir: join(homedir(), ".agents", "skills"),
      skillPaths,
      projectSkillPaths,
      customSkillPaths: this.plainSkillPathEntries(skillPaths).map((path) => this.expandSkillPath(path)),
      enableSkillCommands: settingsManager.getEnableSkillCommands(),
      skills,
      diagnostics,
    };
  }

  async setSkillEnabled(filePath: string, enabled: boolean, cwd?: string): Promise<SkillConfigurationSnapshot> {
    const resolvedCwd = this.mcpCwd(cwd);
    const snapshot = await this.getSkillConfiguration(resolvedCwd);
    const skill = snapshot.skills.find((entry) => entry.filePath === filePath);
    if (!skill) throw new Error(`未找到技能：${filePath}`);
    if (skill.source === "bundled") throw new Error("内置技能不能在此开关。");

    const settingsManager = this.skillSettingsManager(resolvedCwd);
    const patternBaseDir = skill.source === "agents"
      ? join(skill.scope === "project" ? resolvedCwd : homedir(), ".agents")
      : skill.scope === "project"
        ? join(resolvedCwd, ".pi")
        : this.agentDir;
    const pattern = this.skillOverridePattern(skill.filePath, patternBaseDir);

    if (skill.scope === "project") {
      const current = [...(settingsManager.getProjectSettings().skills ?? [])];
      settingsManager.setProjectSkillPaths(this.rewriteSkillOverridePaths(current, pattern, enabled));
    } else {
      settingsManager.setSkillPaths(this.rewriteSkillOverridePaths(settingsManager.getSkillPaths(), pattern, enabled));
    }
    this.reloadActiveSessionResources("Skills 重新加载失败");
    const next = await this.getSkillConfiguration(resolvedCwd);
    this.updateActiveSkillConfiguration(resolvedCwd, next);
    return next;
  }

  async addSkillPath(path: string, cwd?: string): Promise<SkillConfigurationSnapshot> {
    const resolvedCwd = this.mcpCwd(cwd);
    const resolvedPath = this.expandSkillPath(path);
    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
      throw new Error(`技能目录不存在：${resolvedPath}`);
    }
    const settingsManager = this.skillSettingsManager(resolvedCwd);
    const current = settingsManager.getSkillPaths();
    const already = this.plainSkillPathEntries(current).some((entry) => this.expandSkillPath(entry) === resolvedPath);
    if (!already) {
      settingsManager.setSkillPaths([...current, resolvedPath]);
      this.reloadActiveSessionResources("Skills 重新加载失败");
    }
    const next = await this.getSkillConfiguration(resolvedCwd);
    this.updateActiveSkillConfiguration(resolvedCwd, next);
    return next;
  }

  async removeSkillPath(path: string, cwd?: string): Promise<SkillConfigurationSnapshot> {
    const resolvedCwd = this.mcpCwd(cwd);
    const resolvedPath = this.expandSkillPath(path);
    const settingsManager = this.skillSettingsManager(resolvedCwd);
    const next = settingsManager.getSkillPaths().filter((entry) => {
      if (entry.startsWith("+") || entry.startsWith("-") || entry.startsWith("!")) return true;
      try {
        return this.expandSkillPath(entry) !== resolvedPath;
      } catch {
        return entry !== path;
      }
    });
    settingsManager.setSkillPaths(next);
    this.reloadActiveSessionResources("Skills 重新加载失败");
    const snapshot = await this.getSkillConfiguration(resolvedCwd);
    this.updateActiveSkillConfiguration(resolvedCwd, snapshot);
    return snapshot;
  }

  async setEnableSkillCommands(enabled: boolean, cwd?: string): Promise<SkillConfigurationSnapshot> {
    const resolvedCwd = this.mcpCwd(cwd);
    const settingsManager = this.skillSettingsManager(resolvedCwd);
    settingsManager.setEnableSkillCommands(enabled);
    this.reloadActiveSessionResources("Skills 重新加载失败");
    const snapshot = await this.getSkillConfiguration(resolvedCwd);
    this.updateActiveSkillConfiguration(resolvedCwd, snapshot);
    return snapshot;
  }

  private updateActiveSkillConfiguration(cwd: string, snapshot: SkillConfigurationSnapshot): void {
    const active = this.active;
    if (!active || safeRealPath(active.cwd) !== safeRealPath(cwd)) return;
    active.skillConfiguration = snapshot;
    this.publishRuntimeInspection(active);
  }

  private runtimeBridgeRpc(
    method: "get" | "set-system-prompt" | "set-skill-enabled",
    params: Record<string, unknown> = {},
  ): Promise<RuntimeBridgeState> {
    const active = this.requireActive();
    const requestId = `suocode-runtime-${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replyChannel = `${RUNTIME_BRIDGE_REPLY_PREFIX}${requestId}`;
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
        if (raw.ok === true) {
          const state = runtimeBridgeState(raw.state);
          if (!state) {
            finish(() => rejectPromise(new Error("运行时桥接返回了无效状态。")));
            return;
          }
          finish(() => resolvePromise(state));
          return;
        }
        finish(() => rejectPromise(new Error(stringValue(raw.error) || "运行时桥接请求失败。")));
      });
      const timer = setTimeout(() => finish(() => rejectPromise(new Error("运行时桥接请求超时。"))), 8_000);
      active.eventBus.emit(RUNTIME_BRIDGE_COMMAND_EVENT, {
        version: 1,
        requestId,
        method,
        ...params,
      });
    });
  }

  private refreshRuntimeInspectionSources(active: ActiveSession): Promise<void> {
    if (this.runtimeInspectionRefresh) return this.runtimeInspectionRefresh;
    const refresh = Promise.allSettled([
      this.getSkillConfiguration(active.cwd),
      this.getMcpStatus(),
      this.runtimeBridgeRpc("get"),
    ]).then(([skills, mcp, bridge]) => {
      if (this.active !== active) return;
      if (skills.status === "fulfilled") active.skillConfiguration = skills.value;
      if (mcp.status === "fulfilled") active.mcpStatus = mcp.value;
      if (bridge.status === "fulfilled") active.bridgeState = bridge.value;
      this.publishRuntimeInspection(active);
    }).finally(() => {
      if (this.runtimeInspectionRefresh === refresh) this.runtimeInspectionRefresh = undefined;
    });
    this.runtimeInspectionRefresh = refresh;
    return refresh;
  }

  async getRuntimeInspection(): Promise<RuntimeInspectionSnapshot> {
    const active = this.requireActive();
    void this.refreshRuntimeInspectionSources(active);
    return this.runtimeInspection(active);
  }

  async setSessionSystemPrompt(prompt?: string): Promise<RuntimeInspectionSnapshot> {
    const active = this.requireActive();
    active.bridgeState = await this.runtimeBridgeRpc("set-system-prompt", { prompt });
    const inspection = this.runtimeInspection(active);
    this.emitEvent({ type: "runtime_inspection_updated", inspection });
    return inspection;
  }

  async setSessionSkillEnabled(filePath: string, enabled: boolean): Promise<RuntimeInspectionSnapshot> {
    if (!filePath.trim()) throw new Error("缺少 Skill 路径。");
    const active = this.requireActive();
    active.bridgeState = await this.runtimeBridgeRpc("set-skill-enabled", { filePath: filePath.trim(), enabled });
    const inspection = this.runtimeInspection(active);
    this.emitEvent({ type: "runtime_inspection_updated", inspection });
    return inspection;
  }

  private publishManualMemoryStatus(
    active: ActiveSession,
    state: ProjectMemoryRuntimeStatus["state"],
    message: string,
    error?: string,
  ): ProjectMemoryRuntimeStatus {
    const shared = projectMemoryStatusByCwd.get(safeRealPath(active.cwd));
    const previous = active.memoryStatus ?? shared;
    const now = Date.now();
    const next: ProjectMemoryRuntimeStatus = {
      ...previous,
      cwd: active.cwd,
      updatedAt: now,
      attemptId: `manual-${now}-${Math.random().toString(36).slice(2, 8)}`,
      state,
      source: "manual",
      exists: previous?.exists ?? false,
      injected: previous?.injected ?? false,
      processedSessions: previous?.processedSessions ?? [],
      startedAt: state === "running" ? now : previous?.startedAt,
      completedAt: state === "failed" ? now : undefined,
      durationMs: undefined,
      message,
      error,
    };
    active.memoryStatus = next;
    const memoryKey = safeRealPath(active.cwd);
    projectMemoryStatusByCwd.set(
      memoryKey,
      mergeWorkspaceMemoryStatus(projectMemoryStatusByCwd.get(memoryKey), next),
    );
    this.publishRuntimeInspection(active);
    this.emitEvent({
      type: "runtime_notice",
      level: state === "failed" ? "error" : "info",
      message: error || message,
    });
    return next;
  }

  async runMemoryNow(): Promise<{ accepted: true }> {
    const active = this.requireActive();
    if (this.modelTransition) await this.modelTransition;
    if (active.session.isStreaming) {
      const message = "当前回复仍在运行，请结束后再整理项目记忆。";
      this.publishManualMemoryStatus(active, "busy", message);
      throw new Error(message);
    }
    if (this.promptStarting) throw new Error("上一条消息正在启动，请稍候。");
    const sharedMemory = projectMemoryStatusByCwd.get(safeRealPath(active.cwd));
    if (sharedMemory?.state === "running") {
      const message = "当前工作区已有记忆整理正在运行。";
      this.publishManualMemoryStatus(active, "busy", message);
      throw new Error(message);
    }
    if (!active.session.model) {
      const message = "当前没有可用于记忆整理的模型。";
      this.publishManualMemoryStatus(active, "failed", message, message);
      throw new Error(message);
    }
    if (
      active.session.messages.length === 0
      || !active.session.sessionFile
      || !existsSync(active.session.sessionFile)
    ) {
      const message = "当前会话还没有可供整理的历史记录。";
      this.publishManualMemoryStatus(active, "failed", message, message);
      throw new Error(message);
    }
    this.publishManualMemoryStatus(active, "running", "正在启动当前项目的记忆整理…");
    this.promptStarting = true;
    try {
      await active.session.prompt("/memory", {
        preflightResult: () => { this.promptStarting = false; },
      });
    } catch (error) {
      this.promptStarting = false;
      const message = errorMessage(error);
      this.publishManualMemoryStatus(active, "failed", "项目记忆整理启动失败", message);
      throw error;
    }
    return { accepted: true };
  }

  async removeOriginalSessionItem(_entryId: string): Promise<never> {
    throw new Error(ORIGINAL_SESSION_MUTATION_UNSUPPORTED);
  }

  private mcpRpc(method: "status" | "connect" | "auth-start" | "auth-complete" | "logout" | "session-enable", params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const active = this.requireActive();
    const requestId = `suocode-mcp-${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replyChannel = `suocode:mcp:rpc:v1:reply:${requestId}`;
    // pi-mcp-adapter performs a first-run metadata bootstrap before its proxy
    // tool becomes ready. That bootstrap can legitimately consume a server's
    // configured request timeout, so the GUI bridge must not abandon the
    // extension at the old eight-second boundary.
    const timeoutMs = method === "status" ? 30_000 : 120_000;
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
        if (raw.success === true && isRecord(raw.data)) {
          const data = raw.data;
          finish(() => resolvePromise(data));
          return;
        }
        const rpcError = isRecord(raw.error) ? stringValue(raw.error.message) : "MCP 扩展请求失败。";
        finish(() => rejectPromise(new Error(rpcError || "MCP 扩展请求失败。")));
      });
      const timer = setTimeout(() => finish(() => rejectPromise(new Error("MCP 扩展请求超时。"))), timeoutMs);
      active.eventBus.emit("suocode:mcp:rpc:v1:request", {
        version: 1,
        requestId,
        method,
        params,
        source: { client: "suocode-desktop" },
      });
    });
  }

  private mcpStatusFromDetails(details: unknown): McpRuntimeStatus | undefined {
    if (isRecord(details) && (details.error === "not_initialized" || details.error === "init_failed")) return undefined;
    if (!isRecord(details) || details.mode !== "status" || !Array.isArray(details.servers)) {
      const shape = isRecord(details)
        ? `{ mode: ${JSON.stringify(details.mode)}, servers: ${Array.isArray(details.servers) ? "array" : typeof details.servers} }`
        : String(details);
      throw new Error(`pi-mcp-adapter 返回了无效的状态数据：${shape}`);
    }
    const statuses = new Set<McpServerRuntimeStatus["status"]>(["connected", "needs-auth", "failed", "cached", "not connected", "disabled"]);
    const servers = details.servers.map((raw) => {
      if (!isRecord(raw)) throw new Error("pi-mcp-adapter 返回了无效的 Server 状态。");
      const rawStatus = stringValue(raw.status);
      const status = (rawStatus === "not-connected" ? "not connected" : rawStatus) as McpServerRuntimeStatus["status"];
      if (!statuses.has(status)) throw new Error(`未知的 MCP Server 状态：${status || "empty"}`);
      return {
        name: stringValue(raw.name),
        status,
        toolCount: typeof raw.toolCount === "number" && Number.isFinite(raw.toolCount) ? raw.toolCount : 0,
        resourceCount: typeof raw.resourceCount === "number" && Number.isFinite(raw.resourceCount) ? raw.resourceCount : 0,
        failedAgo: typeof raw.failedAgoSeconds === "number" ? raw.failedAgoSeconds : typeof raw.failedAgo === "number" ? raw.failedAgo : null,
        disabled: raw.disabled === true || status === "disabled",
        sessionDisabled: raw.sessionDisabled === true,
      } satisfies McpServerRuntimeStatus;
    });
    return {
      servers,
      totalTools: typeof details.totalTools === "number" && Number.isFinite(details.totalTools) ? details.totalTools : 0,
      totalResources: typeof details.totalResources === "number" && Number.isFinite(details.totalResources) ? details.totalResources : servers.reduce((sum, server) => sum + server.resourceCount, 0),
      connectedCount: typeof details.connectedCount === "number" && Number.isFinite(details.connectedCount) ? details.connectedCount : 0,
      disabledCount: typeof details.disabledCount === "number" && Number.isFinite(details.disabledCount) ? details.disabledCount : servers.filter((server) => server.disabled).length,
      sessionDisabledCount: typeof details.sessionDisabledCount === "number" && Number.isFinite(details.sessionDisabledCount)
        ? details.sessionDisabledCount
        : servers.filter((server) => server.sessionDisabled).length,
      state: "ready",
    };
  }

  private async mcpSensitiveValues(cwd?: string): Promise<string[]> {
    const configuration = await this.getMcpConfiguration(cwd);
    const secrets: string[] = [];
    for (const server of configuration.servers) {
      for (const [key, value] of [...Object.entries(server.env), ...Object.entries(server.headers)]) {
        if (sensitiveConfigurationKey(key) && value && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) secrets.push(value);
      }
      if (server.url) {
        try {
          const parsed = new URL(server.url);
          if (parsed.username) secrets.push(decodeURIComponent(parsed.username));
          if (parsed.password) secrets.push(decodeURIComponent(parsed.password));
          for (const [key, value] of parsed.searchParams) if (sensitiveConfigurationKey(key) && value) secrets.push(value);
        } catch {
          // Invalid URLs are rejected when saved; imported malformed entries have no safe structured secrets to inspect.
        }
      }
    }
    return secrets;
  }

  /**
   * The configured server list is the single source of truth for *membership*;
   * the extension only enriches each entry with live tool counts and auth state.
   *
   * The Agent-facing adapter intentionally omits disabled and deleted servers,
   * and it reports nothing at all while booting. Deriving GUI membership from
   * that capability view would make the list grow and shrink under the user, so
   * every assignment to `mcpStatus` must come through here.
   */
  private async normalizeMcpStatus(
    reported: McpRuntimeStatus | undefined,
    fallbackState: McpRuntimeStatus["state"],
    diagnostic?: string,
  ): Promise<McpRuntimeStatus> {
    // Pass the active cwd: `loadMcpConfig` resolves project overrides against it
    // either way, so omitting it would read those overrides without first
    // reconciling them — leaving the inspector and Settings disagreeing.
    const configuration = await this.getMcpConfiguration(this.active?.cwd);
    const reportedByName = new Map((reported?.servers ?? []).map((server) => [server.name, server]));
    const servers = configuration.servers.map((server) => {
      const live = reportedByName.get(server.name);
      return {
        name: server.name,
        status: server.disabled ? "disabled" as const : live?.status ?? "not connected" as const,
        toolCount: live?.toolCount ?? 0,
        resourceCount: live?.resourceCount ?? 0,
        failedAgo: live?.failedAgo ?? null,
        disabled: server.disabled,
        sessionDisabled: live?.sessionDisabled ?? false,
      } satisfies McpServerRuntimeStatus;
    });
    const visible = servers.filter((server) => !server.disabled && !server.sessionDisabled);
    return {
      servers,
      totalTools: visible.reduce((sum, server) => sum + server.toolCount, 0),
      totalResources: visible.reduce((sum, server) => sum + server.resourceCount, 0),
      connectedCount: visible.filter((server) => server.status === "connected").length,
      disabledCount: servers.filter((server) => server.disabled).length,
      sessionDisabledCount: servers.filter((server) => server.sessionDisabled).length,
      state: reported ? "ready" : fallbackState,
      diagnostic: reported ? undefined : diagnostic,
    };
  }

  async getMcpStatus(): Promise<McpRuntimeStatus> {
    const secrets = await this.mcpSensitiveValues();
    let result: Record<string, unknown>;
    try {
      result = await this.mcpRpc("status");
    } catch (error) {
      throw new Error(redactSensitiveText(errorMessage(error), secrets));
    }
    const details = isRecord(result.details) ? result.details : {};
    return this.normalizeMcpStatus(
      this.mcpStatusFromDetails(result.details),
      details.error === "init_failed" ? "unavailable" : "initializing",
      redactSensitiveText(stringValue(details.message) || stringValue(result.text), secrets) || undefined,
    );
  }

  private async mcpAction(method: "connect" | "auth-start" | "auth-complete" | "logout", params: Record<string, unknown>): Promise<McpActionResult> {
    const secrets = await this.mcpSensitiveValues();
    let result: Record<string, unknown>;
    try {
      result = await this.mcpRpc(method, params);
    } catch (error) {
      throw new Error(redactSensitiveText(errorMessage(error), secrets));
    }
    let status: McpRuntimeStatus | undefined;
    try {
      status = await this.getMcpStatus();
    } catch {
      status = undefined;
    }
    return {
      text: redactSensitiveText(stringValue(result.text), secrets),
      details: isRecord(result.details) ? redactSensitiveValue(result.details, secrets) as Record<string, unknown> : undefined,
      status,
    };
  }

  async connectMcpServer(name: string): Promise<McpActionResult> {
    if (!name.trim()) throw new Error("缺少 MCP Server 名称。");
    return this.mcpAction("connect", { server: name.trim() });
  }

  async startMcpAuth(name: string): Promise<McpActionResult> {
    if (!name.trim()) throw new Error("缺少 MCP Server 名称。");
    return this.mcpAction("auth-start", { server: name.trim() });
  }

  async completeMcpAuth(name: string, input: string): Promise<McpActionResult> {
    if (!name.trim()) throw new Error("缺少 MCP Server 名称。");
    if (!input.trim()) throw new Error("缺少 OAuth 回调内容。");
    return this.mcpAction("auth-complete", { server: name.trim(), input: input.trim() });
  }

  async logoutMcpServer(name: string): Promise<McpActionResult> {
    if (!name.trim()) throw new Error("缺少 MCP Server 名称。");
    return this.mcpAction("logout", { server: name.trim() });
  }

  async setSessionMcpServerEnabled(name: string, enabled: boolean): Promise<RuntimeInspectionSnapshot> {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("缺少 MCP Server 名称。");
    const active = this.requireActive();
    const result = await this.mcpRpc("session-enable", { server: normalizedName, enabled });
    const reported = this.mcpStatusFromDetails(result.details);
    if (!reported) throw new Error("MCP 扩展没有返回当前会话状态。");
    active.mcpStatus = await this.normalizeMcpStatus(reported, "ready");
    const inspection = this.runtimeInspection(active);
    this.emitEvent({ type: "runtime_inspection_updated", inspection });
    return inspection;
  }

  private removedMcpServersPath(): string {
    return join(this.agentDir, "mcp-removed-servers.json");
  }

  private disabledMcpServersPath(): string {
    return join(this.agentDir, "mcp-disabled-servers.json");
  }

  private readNamedMcpServerSet(path: string): Set<string> {
    if (!existsSync(path)) return new Set();
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const list = isRecord(parsed) && Array.isArray(parsed.servers)
        ? parsed.servers
        : Array.isArray(parsed) ? parsed : [];
      return new Set(list.filter((name): name is string => typeof name === "string" && Boolean(name.trim())).map((name) => name.trim()));
    } catch {
      return new Set();
    }
  }

  private writeNamedMcpServerSet(path: string, names: Set<string>): void {
    mkdirSync(this.agentDir, { recursive: true });
    const servers = [...names].sort((left, right) => left.localeCompare(right));
    writeFileSync(path, `${JSON.stringify({ servers }, null, 2)}\n`, "utf8");
  }

  private readRemovedMcpServers(): Set<string> {
    return this.readNamedMcpServerSet(this.removedMcpServersPath());
  }

  private writeRemovedMcpServers(names: Set<string>): void {
    this.writeNamedMcpServerSet(this.removedMcpServersPath(), names);
  }

  private readDisabledMcpServers(): Set<string> {
    return this.readNamedMcpServerSet(this.disabledMcpServersPath());
  }

  private writeDisabledMcpServers(names: Set<string>): void {
    this.writeNamedMcpServerSet(this.disabledMcpServersPath(), names);
  }

  private markMcpServerRemovedLocally(name: string): void {
    const removed = this.readRemovedMcpServers();
    removed.add(name);
    this.writeRemovedMcpServers(removed);
    // Deletion and disablement are different product states. A deleted import
    // stays in this private exclusion set, but must not linger in the user-
    // visible disabled set or in Pi's effective configuration.
    this.setMcpServerOptOut(name, false);
  }

  private clearMcpServerRemovedLocally(name: string): void {
    const removed = this.readRemovedMcpServers();
    if (!removed.delete(name)) return;
    this.writeRemovedMcpServers(removed);
  }

  private setMcpServerOptOut(name: string, disabled: boolean): void {
    const optOut = this.readDisabledMcpServers();
    if (disabled) optOut.add(name);
    else optOut.delete(name);
    this.writeDisabledMcpServers(optOut);
  }

  private removeBareMcpServerTombstone(configPath: string, name: string): boolean {
    if (!existsSync(configPath)) return false;
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
      if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return false;
      const entry = parsed.mcpServers[name];
      if (!isRecord(entry) || entry.disabled !== true || Object.keys(entry).some((key) => key !== "disabled")) return false;
      delete parsed.mcpServers[name];
      const temporaryPath = `${configPath}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      renameSync(temporaryPath, configPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Migrates the old reversible-removal representation. Removed names remain
   * in SuoCode's private exclusion set, while stale `{ disabled: true }`
   * shadows and disabled-list entries are erased so Pi never receives them.
   */
  private cleanRemovedMcpServerState(adapter: McpAdapterConfigModule, cwd?: string): boolean {
    const removed = this.readRemovedMcpServers();
    if (removed.size === 0) return false;
    let changed = false;
    const disabled = this.readDisabledMcpServers();
    for (const name of removed) if (disabled.delete(name)) changed = true;
    if (changed) this.writeDisabledMcpServers(disabled);

    const globalConfigPath = adapter.getPiGlobalConfigPath(join(this.agentDir, "mcp.json"));
    const projectConfigPath = cwd ? adapter.getProjectPiConfigPath(cwd) : undefined;
    for (const name of removed) {
      if (this.removeBareMcpServerTombstone(globalConfigPath, name)) changed = true;
      if (projectConfigPath && this.removeBareMcpServerTombstone(projectConfigPath, name)) changed = true;
    }
    return changed;
  }

  /**
   * A configured MCP Server is available to the Agent unless the user has
   * explicitly turned it off. Lifecycle (`lazy` / `keep-alive` / `eager`) decides
   * *when* it connects, not *whether* the Agent may see it — lazy loading is a
   * property of an enabled server, not a separate half-on state.
   */
  private async syncMcpOptOutDisabledState(cwd?: string): Promise<boolean> {
    if (!cwd) return false;
    const adapter = await loadMcpAdapterConfigModule();
    const globalConfigPath = adapter.getPiGlobalConfigPath(join(this.agentDir, "mcp.json"));
    const resolvedCwd = this.mcpCwd(cwd);
    const config = adapter.loadMcpConfig(globalConfigPath, resolvedCwd);
    const disabled = this.readDisabledMcpServers();
    const removed = this.readRemovedMcpServers();
    let changed = false;
    for (const name of Object.keys(config.mcpServers)) {
      if (removed.has(name)) continue;
      const result = adapter.writeProjectServerDisabledOverride(globalConfigPath, resolvedCwd, name, disabled.has(name));
      if (result.changed) changed = true;
    }
    return changed;
  }

  async getMcpConfiguration(cwd?: string): Promise<McpConfigurationSnapshot> {
    const adapter = await loadMcpAdapterConfigModule();
    const configPath = adapter.getPiGlobalConfigPath(join(this.agentDir, "mcp.json"));
    const resolvedCwd = this.mcpCwd(cwd);
    const cleaned = this.cleanRemovedMcpServerState(adapter, resolvedCwd);
    const synchronized = await this.syncMcpOptOutDisabledState(cwd);
    if (cleaned || synchronized) this.reloadMcpExtension();
    const projectConfigPath = cwd ? adapter.getProjectPiConfigPath(resolvedCwd) : undefined;
    const config = adapter.loadMcpConfig(configPath, resolvedCwd);
    const discovery = adapter.getMcpDiscoverySummary(configPath, resolvedCwd);
    const provenance = adapter.getServerProvenance(configPath, resolvedCwd);
    const projectDefinitions = mcpServerDefinitions(projectConfigPath);
    const enabledImports = new Set(config.imports ?? []);
    const removed = this.readRemovedMcpServers();
    const optedOut = this.readDisabledMcpServers();
    return {
      configPath,
      projectConfigPath,
      imports: discovery.imports.map((entry) => ({ ...entry, enabled: enabledImports.has(entry.kind) })),
      servers: Object.entries(config.mcpServers).filter(([name]) => !removed.has(name)).map(([name, raw]) => {
        const source = provenance.get(name);
        return {
          name,
          // A project file may contain only { disabled: true } for a global or
          // imported server. That override changes enablement, not ownership.
          scope: source?.kind === "project" && projectDefinitions.has(name) ? "project" : "global",
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
          disabled: raw.disabled === true || optedOut.has(name),
          source: source?.path,
          sourceKind: source?.kind,
          importKind: mcpImportKind(source?.importKind),
        } satisfies McpServerConfiguration;
      }).sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  private async mcpJsonPath(): Promise<string> {
    const adapter = await loadMcpAdapterConfigModule();
    return adapter.getPiGlobalConfigPath(join(this.agentDir, "mcp.json"));
  }

  async getMcpJson(): Promise<McpJsonDocument> {
    const path = await this.mcpJsonPath();
    if (!existsSync(path)) {
      return { path, content: `${JSON.stringify({ mcpServers: {} }, null, 2)}\n` };
    }
    return { path, content: readFileSync(path, "utf8") };
  }

  async saveMcpJson(content: string, cwd?: string): Promise<McpConfigurationSnapshot> {
    const validated = validateMcpJsonText(content);
    if (!validated.ok) throw new Error(validated.error);
    const path = await this.mcpJsonPath();
    mkdirSync(dirname(path), { recursive: true });
    const normalized = `${JSON.stringify(validated.value, null, 2)}\n`;
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, normalized, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
    const removed = this.readRemovedMcpServers();
    let removedChanged = false;
    for (const name of mcpServerDefinitions(path)) if (removed.delete(name)) removedChanged = true;
    if (removedChanged) this.writeRemovedMcpServers(removed);
    await this.reloadMcpExtensionNow();
    return this.getMcpConfiguration(cwd);
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
    if (server.disabled) definition.disabled = true;
    adapter.writeSharedServerEntry(configPath, name, definition);
    this.clearMcpServerRemovedLocally(name);
    if (previousName && previousName !== name) {
      this.clearMcpServerRemovedLocally(previousName);
      this.setMcpServerOptOut(previousName, true);
    }
    // Saving keeps the current state: a server is available unless explicitly 停用.
    this.setMcpServerOptOut(name, server.disabled === true);
    if (cwd) {
      adapter.writeProjectServerDisabledOverride(globalConfigPath, resolvedCwd, name, server.disabled === true);
    }
    await this.reloadMcpExtensionNow();
    return this.getMcpConfiguration(cwd);
  }

  private removeMcpServerFromFile(configPath: string, name: string): boolean {
    if (!existsSync(configPath)) return false;
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers) || !(name in servers)) return false;
    delete (servers as Record<string, unknown>)[name];
    const temporaryPath = `${configPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, configPath);
    return true;
  }

  async removeMcpServer(name: string, scope: "global" | "project" = "global", cwd?: string): Promise<McpConfigurationSnapshot> {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("缺少 MCP Server 名称。");
    const adapter = await loadMcpAdapterConfigModule();
    const globalConfigPath = adapter.getPiGlobalConfigPath(join(this.agentDir, "mcp.json"));
    const resolvedCwd = cwd ? this.mcpCwd(cwd) : undefined;
    if (scope === "project" && !resolvedCwd) throw new Error("项目级 MCP 需要当前工作区。");
    const projectConfigPath = resolvedCwd ? adapter.getProjectPiConfigPath(resolvedCwd) : undefined;
    const before = await this.getMcpConfiguration(cwd);
    if (!before.servers.some((server) => server.name === normalizedName)) {
      throw new Error(`MCP Server 不存在：${normalizedName}`);
    }

    const tryRemove = (configPath?: string): void => {
      if (!configPath) return;
      this.removeMcpServerFromFile(configPath, normalizedName);
    };

    // Only mutate SuoCode-owned files. Never delete Cursor/Claude/Codex imports or shared `.mcp.json`.
    tryRemove(globalConfigPath);
    tryRemove(projectConfigPath);
    const provenance = adapter.getServerProvenance(globalConfigPath, resolvedCwd ?? process.cwd());
    const source = provenance.get(normalizedName);
    if (source?.path && (source.kind === "user" || source.kind === "project") && (source.path === globalConfigPath || source.path === projectConfigPath)) {
      tryRemove(source.path);
    }

    // External/shared definitions belong to another application, so SuoCode
    // does not mutate their source file. The private exclusion is permanent
    // from SuoCode's perspective and is never exposed to Pi or the Settings UI.
    const stillPresent = Boolean(adapter.loadMcpConfig(globalConfigPath, resolvedCwd ?? process.cwd()).mcpServers[normalizedName]);
    if (stillPresent) {
      this.markMcpServerRemovedLocally(normalizedName);
    } else {
      this.clearMcpServerRemovedLocally(normalizedName);
      this.setMcpServerOptOut(normalizedName, false);
    }

    await this.reloadMcpExtensionNow();
    return this.getMcpConfiguration(cwd);
  }

  async setMcpServerEnabled(name: string, enabled: boolean, cwd: string): Promise<McpConfigurationSnapshot> {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("缺少 MCP Server 名称。");
    const adapter = await loadMcpAdapterConfigModule();
    const resolvedCwd = this.mcpCwd(cwd);
    const globalConfigPath = adapter.getPiGlobalConfigPath(join(this.agentDir, "mcp.json"));
    const effective = adapter.loadMcpConfig(globalConfigPath, resolvedCwd);
    if (!effective.mcpServers[normalizedName]) throw new Error(`MCP Server 不存在：${normalizedName}`);
    this.setMcpServerOptOut(normalizedName, !enabled);
    adapter.writeProjectServerDisabledOverride(globalConfigPath, resolvedCwd, normalizedName, !enabled);
    await this.reloadMcpExtensionNow();
    return this.getMcpConfiguration(resolvedCwd);
  }

  async enableMcpImports(imports: McpImportConfiguration["kind"][], cwd?: string): Promise<McpConfigurationSnapshot> {
    const adapter = await loadMcpAdapterConfigModule();
    adapter.ensureCompatibilityImports(imports, join(this.agentDir, "mcp.json"));
    await this.reloadMcpExtensionNow();
    return this.getMcpConfiguration(cwd);
  }

  async listSessions(cwd: string): Promise<SessionSummary[]> {
    const resolvedCwd = safeRealPath(cwd);
    const sessions = await SessionManager.list(resolvedCwd, this.sessionDir);
    const archived = this.readArchivedSessions();
    const pinned = this.readPinnedSessions();
    const mapped = sessions
      .filter((session) => !archived[safeRealPath(session.path)])
      .map((session) => {
        const path = safeRealPath(session.path);
        const pinnedAt = pinned[path];
        return {
          ...sessionSummary(session),
          ...(pinnedAt ? { pinned: true as const, pinnedAt } : {}),
        };
      })
      .sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      });
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

  private async requireProjectSession(cwd: string, sessionPath: string): Promise<{ resolvedCwd: string; resolvedSession: string }> {
    const resolvedCwd = safeRealPath(cwd);
    const resolvedSession = ensureInside(this.sessionDir, sessionPath);
    const belongsToProject = (await SessionManager.list(resolvedCwd, this.sessionDir))
      .some((session) => safeRealPath(session.path) === safeRealPath(resolvedSession));
    if (!belongsToProject) throw new Error("所选会话不属于当前工作区。");
    return { resolvedCwd, resolvedSession };
  }

  async archiveSession(cwd: string, sessionPath: string): Promise<SessionSummary[]> {
    const { resolvedCwd, resolvedSession } = await this.requireProjectSession(cwd, sessionPath);
    const archived = this.readArchivedSessions();
    archived[safeRealPath(resolvedSession)] = new Date().toISOString();
    this.writeArchivedSessions(archived);
    const pinned = this.readPinnedSessions();
    if (pinned[safeRealPath(resolvedSession)]) {
      delete pinned[safeRealPath(resolvedSession)];
      this.writePinnedSessions(pinned);
    }
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

  async renameSession(cwd: string, sessionPath: string, name: string): Promise<SessionSummary[]> {
    const nextName = name.replace(/[\r\n]+/g, " ").trim();
    if (!nextName) throw new Error("会话名称不能为空。");
    const { resolvedCwd, resolvedSession } = await this.requireProjectSession(cwd, sessionPath);
    const activeFile = this.active?.session.sessionFile ? safeRealPath(this.active.session.sessionFile) : undefined;
    if (activeFile && activeFile === safeRealPath(resolvedSession)) {
      this.active!.session.setSessionName(nextName);
      this.emitEvent({ type: "session_snapshot", snapshot: await this.snapshot() });
    } else {
      SessionManager.open(resolvedSession, this.sessionDir).appendSessionInfo(nextName);
    }
    return this.listSessions(resolvedCwd);
  }

  async pinSession(cwd: string, sessionPath: string, pinned: boolean): Promise<SessionSummary[]> {
    const { resolvedCwd, resolvedSession } = await this.requireProjectSession(cwd, sessionPath);
    const map = this.readPinnedSessions();
    const key = safeRealPath(resolvedSession);
    if (pinned) map[key] = new Date().toISOString();
    else delete map[key];
    this.writePinnedSessions(map);
    return this.listSessions(resolvedCwd);
  }

  async forkSession(cwd: string, sessionPath: string): Promise<{ sessions: SessionSummary[]; session: SessionSummary }> {
    const { resolvedCwd, resolvedSession } = await this.requireProjectSession(cwd, sessionPath);
    const source = (await SessionManager.list(resolvedCwd, this.sessionDir))
      .find((session) => safeRealPath(session.path) === safeRealPath(resolvedSession));
    if (!source) throw new Error("所选会话不属于当前工作区。");
    const forked = SessionManager.forkFrom(resolvedSession, resolvedCwd, this.sessionDir);
    const title = (source.name || titleFromText(source.firstMessage) || "对话").trim();
    forked.appendSessionInfo(`${title} (副本)`);
    const forkedPath = forked.getSessionFile();
    if (!forkedPath) throw new Error("分叉会话失败：未能创建会话文件。");
    const sessions = await this.listSessions(resolvedCwd);
    const session = sessions.find((item) => safeRealPath(item.path) === safeRealPath(forkedPath));
    if (!session) throw new Error("分叉会话已创建，但未能出现在列表中。");
    return { sessions, session };
  }

  async openWorkspace(cwd: string): Promise<{ sessions: SessionSummary[]; snapshot: SessionSnapshot }> {
    const sessions = await this.listSessions(cwd);
    const snapshot = sessions[0]
      ? await this.openSession(cwd, sessions[0].path)
      : await this.createSession(cwd);
    return { sessions, snapshot };
  }

  async createSession(cwd: string, selection?: SessionModelSelection): Promise<SessionSnapshot> {
    const resolvedCwd = safeRealPath(cwd);
    if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
      throw new Error(`Project directory does not exist: ${resolvedCwd}`);
    }
    return this.installSession(resolvedCwd, SessionManager.create(resolvedCwd, this.sessionDir), selection);
  }

  async openSession(cwd: string, sessionPath: string): Promise<SessionSnapshot> {
    const resolvedCwd = safeRealPath(cwd);
    const resolvedSession = ensureInside(this.sessionDir, sessionPath);
    if (!existsSync(resolvedSession)) throw new Error("所选会话已不存在。");
    return this.installSession(resolvedCwd, SessionManager.open(resolvedSession, this.sessionDir, resolvedCwd));
  }

  private async installSession(
    cwd: string,
    sessionManager: SessionManager,
    initialModel?: SessionModelSelection,
  ): Promise<SessionSnapshot> {
    const timingEnabled = process.env.SUOCODE_RUNTIME_TIMING === "1";
    const timingStartedAt = Date.now();
    const timings: Record<string, number> = {};
    let timingCheckpoint = timingStartedAt;
    const markTiming = (name: string): void => {
      if (!timingEnabled) return;
      const now = Date.now();
      timings[name] = now - timingCheckpoint;
      timingCheckpoint = now;
    };
    const modelRuntimeStartedAt = Date.now();
    const modelRuntimePromise = this.ready().then((runtime) => {
      if (timingEnabled) timings.modelRuntime = Date.now() - modelRuntimeStartedAt;
      return runtime;
    });
    if (this.projectRefreshTimer) clearTimeout(this.projectRefreshTimer);
    if (this.active) {
      const previous = this.active;
      this.active = undefined;
      previous.unsubscribe();
      await shutdownAgentSession(previous.session, "quit").catch(() => undefined);
      previous.eventBus.clear();
    }

    const settingsManager = SettingsManager.create(cwd, this.agentDir, { projectTrusted: true });
    configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
    const eventBus = createEventBus();
    let installedActive: ActiveSession | undefined;
    let pendingBridgeState: RuntimeBridgeState | undefined;
    let pendingMemoryStatus: ProjectMemoryRuntimeStatus | undefined;
    let pendingPlanApproval: PlanApprovalState | undefined;
    eventBus.on(RUNTIME_BRIDGE_STATE_EVENT, (value) => {
      const next = runtimeBridgeState(value);
      if (!next) return;
      pendingBridgeState = next;
      if (!installedActive) return;
      installedActive.bridgeState = next;
      this.publishRuntimeInspection(installedActive);
    });
    eventBus.on(PROJECT_MEMORY_STATUS_EVENT, (value) => {
      const parsed = projectMemoryStatus(value);
      const next = parsed ? hydrateProjectMemoryStatus({ ...parsed, cwd: parsed.cwd || cwd }) : undefined;
      if (!next) return;
      const previous = installedActive?.memoryStatus ?? pendingMemoryStatus;
      pendingMemoryStatus = next;
      const memoryKey = safeRealPath(next.cwd);
      projectMemoryStatusByCwd.set(
        memoryKey,
        mergeWorkspaceMemoryStatus(projectMemoryStatusByCwd.get(memoryKey), next),
      );
      if (!installedActive) return;
      installedActive.memoryStatus = next;
      this.publishRuntimeInspection(installedActive);
      if (next.source !== "manual" || previous?.state === next.state) return;
      if (next.state === "running") this.emitEvent({ type: "runtime_notice", level: "info", message: next.message || "正在整理当前项目记忆…" });
      else if (next.state === "succeeded") this.emitEvent({ type: "runtime_notice", level: "success", message: next.message || "项目记忆整理完成" });
      else if (next.state === "busy") this.emitEvent({ type: "runtime_notice", level: "info", message: next.message || "当前项目已有记忆整理正在运行" });
      else if (next.state === "failed") this.emitEvent({ type: "runtime_notice", level: "error", message: next.error || "项目记忆整理失败" });
    });
    eventBus.on(PLAN_STATE_CHANNEL, (value) => {
      const next = planApprovalState(value);
      if (value !== null && value !== undefined && !next) return;
      pendingPlanApproval = next;
      if (!installedActive) return;
      installedActive.planApproval = next;
      installedActive.project = { ...installedActive.project, planApproval: next, refreshedAt: Date.now() };
      this.emitEvent({ type: "plan_approval_updated", plan: next });
      this.emitEvent({ type: "project_updated", project: installedActive.project });
    });
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
    await this.refreshAgentMcpConfiguration(eventBus, cwd);
    const resourceLoaderStartedAt = Date.now();
    const resourceLoaderPromise = loader.reload().then(() => {
      if (timingEnabled) timings.resourceLoader = Date.now() - resourceLoaderStartedAt;
    });
    const [modelRuntime] = await Promise.all([modelRuntimePromise, resourceLoaderPromise]);
    timingCheckpoint = Date.now();
    const selectedModel = initialModel
      ? modelRuntime.getModel(initialModel.provider, initialModel.modelId)
      : undefined;
    if (initialModel && !selectedModel) {
      throw new Error(`Unknown model: ${initialModel.provider}/${initialModel.modelId}`);
    }
    if (selectedModel && !(await modelRuntime.checkAuth(selectedModel.provider))) {
      throw new Error(`No credential is configured for ${selectedModel.provider}.`);
    }
    const effectiveInitialModel = selectedModel ? this.modelWithRuntimeOptions(selectedModel) : undefined;
    const effectiveInitialThinkingLevel = effectiveInitialModel && initialModel
      ? clampThinkingLevel(effectiveInitialModel, initialModel.thinkingLevel) as ThinkingLevel
      : undefined;
    const extensionErrors = loader.getExtensions().errors;
    if (extensionErrors.length > 0) {
      const message = extensionErrors.map((entry) => `${entry.path}: ${entry.error}`).join("\n");
      throw new Error(`SuoCode workflow failed to load:\n${message}`);
    }
    if (timingEnabled) {
      for (const extension of loader.getExtensions().extensions) {
        const handlers = extension.handlers.get("session_start");
        if (!handlers?.length) continue;
        extension.handlers.set("session_start", handlers.map((handler, index) => (async (...args: Parameters<typeof handler>) => {
          const startedAt = Date.now();
          try {
            return await handler(...args);
          } finally {
            process.stderr.write(`[suocode-runtime-timing] ${JSON.stringify({ extension: extension.path, event: "session_start", handler: index, elapsedMs: Date.now() - startedAt })}\n`);
          }
        }) as typeof handler));
      }
    }

    const created = await createAgentSession({
      cwd,
      agentDir: this.agentDir,
      modelRuntime,
      settingsManager,
      sessionManager,
      resourceLoader: loader,
      model: effectiveInitialModel,
      thinkingLevel: effectiveInitialThinkingLevel,
    });
    markTiming("createAgentSession");
    await created.session.bindExtensions({});
    markTiming("bindExtensions");
    if (created.session.model) {
      const effectiveModel = this.modelWithRuntimeOptions(created.session.model);
      if (effectiveModel !== created.session.model) await created.session.setModel(effectiveModel);
    }
    created.session.setActiveToolsByName(created.session.getActiveToolNames().filter((name) => name !== "find"));
    const activeToolNames = new Set(created.session.getActiveToolNames());
    const requiredTools = ["read", "bash", "edit", "write", "grep", "ls", "todo", "terminal", "mcp", "subagent", "plan"];
    const missingTools = requiredTools.filter((name) => !activeToolNames.has(name));
    if (missingTools.length > 0) {
      await shutdownAgentSession(created.session, "quit").catch(() => undefined);
      throw new Error(`SuoCode workflow did not activate required tools: ${missingTools.join(", ")}`);
    }

    const reconstructed = this.reconstructState(created.session);
    const files = await directoryNodes(cwd);
    markTiming("restoreAndFiles");
    const project: ProjectSnapshot = {
      cwd,
      files,
      changes: [],
      terminals: [...reconstructed.terminals.values()],
      plan: reconstructed.plan,
      planApproval: reconstructed.planApproval ?? pendingPlanApproval,
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
      messageRevision: 0,
      pendingUserMessageIds: [],
      nextTimelineOrder: reconstructed.nextTimelineOrder,
      responseMetrics: reconstructed.responseMetrics,
      responseMetricsHistory: reconstructed.responseMetricsHistory,
      sessionRevision: 1,
      bridgeState: pendingBridgeState,
      memoryStatus: pendingMemoryStatus ?? projectMemoryStatusByCwd.get(safeRealPath(cwd)),
      planApproval: reconstructed.planApproval ?? pendingPlanApproval,
      eventBus,
    };
    installedActive = active;
    this.active = active;
    active.unsubscribe = created.session.subscribe((event) => this.handleSessionEvent(event));
    eventBus.on(SUBAGENT_ACTIVITY_CHANNEL, (raw) => {
      if (this.active !== active) return;
      this.mergeSubagentActivities(subagentActivitiesFromPayload(raw));
    });
    const snapshot = await this.snapshot(reconstructed);
    markTiming("snapshot");
    this.emitEvent({ type: "session_snapshot", snapshot });
    void this.refreshRuntimeInspectionSources(active);
    setTimeout(() => {
      if (this.active !== active) return;
      void this.refreshProject().catch((error) => {
        this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
      });
      void this.listSessions(cwd).catch((error) => {
        this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
      });
    }, 0);
    if (timingEnabled) {
      process.stderr.write(`[suocode-runtime-timing] ${JSON.stringify({ cwd, totalMs: Date.now() - timingStartedAt, ...timings })}\n`);
    }
    return snapshot;
  }

  private reconstructState(session: AgentSession): ReconstructedSessionState {
    const messages: ChatMessage[] = [];
    const tools = new Map<string, ToolRun>();
    const subagents = new Map<string, SubagentActivity>();
    const terminals = new Map<string, TerminalRun>();
    let plan: TodoItem[] = [];
    let planApproval: PlanApprovalState | undefined;
    const calls = new Map<string, { name: string; args: Record<string, unknown>; timestamp: number }>();
    const purposes = restoredToolPurposes(session);
    let order = 0;

    const branchMessages = session.sessionManager.getBranch().filter((entry) => entry.type === "message");
    for (const [index, entry] of branchMessages.entries()) {
      const rawMessage = entry.message;
      if (!isRecord(rawMessage)) continue;
      const liveMessageId = this.active?.messageIds.get(rawMessage);
      const mapped = mapMessage(rawMessage, liveMessageId ?? `history-${entry.id}`, order, entry.id);
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
      if (name === "plan") {
        const restoredApproval = planApprovalState(isRecord(rawMessage.details) ? rawMessage.details.plan ?? rawMessage.details : undefined);
        if (restoredApproval) planApproval = restoredApproval;
      }
      if (name === "subagent") {
        const activity = subagentActivityFromDetails(rawMessage.details, id);
        if (activity) subagents.set(activity.id, restoredSubagentActivity(activity));
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
    for (const entry of session.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== SUBAGENT_RUN_ENTRY_TYPE) continue;
      for (const activity of subagentActivitiesFromPayload({ activities: [entry.data] })) {
        subagents.set(activity.id, restoredSubagentActivity(activity));
      }
    }
    for (const entry of session.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== PLAN_ENTRY_TYPE) continue;
      const restored = planApprovalState(entry.data);
      if (restored) planApproval = restored;
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
      planApproval,
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
    if (name === "plan") return "创建执行计划";
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

  private queueClientMessage(active: ActiveSession, clientMessageId?: string): void {
    if (!clientMessageId || active.pendingUserMessageIds.includes(clientMessageId)) return;
    active.pendingUserMessageIds.push(clientMessageId);
  }

  private rejectClientMessage(active: ActiveSession, clientMessageId?: string): void {
    if (!clientMessageId) return;
    const index = active.pendingUserMessageIds.indexOf(clientMessageId);
    if (index >= 0) active.pendingUserMessageIds.splice(index, 1);
    this.emitEvent({ type: "message_rejected", id: clientMessageId, revision: ++active.messageRevision });
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
        currentTool: activity.currentTool,
        currentPath: activity.currentPath,
        model: activity.model ?? existing.model,
        recentTools: activity.recentTools ?? existing.recentTools,
        recentOutput: activity.recentOutput ?? existing.recentOutput,
        messages: activity.messages ?? existing.messages,
        toolCalls: activity.toolCalls ?? existing.toolCalls,
        timeline: activity.timeline ?? existing.timeline,
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

  private subagentRpc(method: "stop" | "status" | "resume", id: string): Promise<unknown> {
    const active = this.requireActive();
    const requestId = `suocode-${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replyChannel = `suocode:subagents:rpc:v1:reply:${requestId}`;
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
      active.eventBus.emit(SUBAGENT_RPC_REQUEST_CHANNEL, {
        version: 1,
        requestId,
        method,
        params: { id },
        source: { client: "suocode-desktop" },
      });
    });
  }

  private planRpc(method: "approve" | "reject", params: { planId: string; target?: PlanExecutionTarget; agent?: string }): Promise<unknown> {
    const active = this.requireActive();
    const requestId = `suocode-plan-${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replyChannel = `suocode:plan:rpc:v1:reply:${requestId}`;
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
        const rpcError = isRecord(raw.error) ? stringValue(raw.error.message) : "计划操作失败。";
        finish(() => rejectPromise(new Error(rpcError || "计划操作失败。")));
      });
      const timer = setTimeout(() => finish(() => rejectPromise(new Error("计划操作请求超时。"))), 20_000);
      active.eventBus.emit(PLAN_RPC_REQUEST_CHANNEL, {
        version: 1,
        requestId,
        method,
        params,
        source: { client: "suocode-desktop" },
      });
    });
  }

  async approvePlan(planId: string, target: PlanExecutionTarget, agent?: string): Promise<PlanApprovalState> {
    const normalized = planId.trim();
    if (!normalized) throw new Error("缺少计划标识。");
    const reply = await this.planRpc("approve", { planId: normalized, target, agent });
    const plan = isRecord(reply) && isRecord(reply.plan) ? planApprovalState(reply.plan) : undefined;
    if (!plan) throw new Error("计划审批响应缺少有效状态。");
    const active = this.requireActive();
    if (active.planApproval?.id !== plan.id || active.planApproval.revision !== plan.revision) {
      active.planApproval = plan;
      active.project = { ...active.project, planApproval: plan, refreshedAt: Date.now() };
      this.emitEvent({ type: "plan_approval_updated", plan });
      this.emitEvent({ type: "project_updated", project: active.project });
    }
    return plan;
  }

  async rejectPlan(planId: string): Promise<PlanApprovalState> {
    const normalized = planId.trim();
    if (!normalized) throw new Error("缺少计划标识。");
    const reply = await this.planRpc("reject", { planId: normalized });
    const plan = isRecord(reply) && isRecord(reply.plan) ? planApprovalState(reply.plan) : undefined;
    if (!plan) throw new Error("计划拒绝响应缺少有效状态。");
    const active = this.requireActive();
    if (active.planApproval?.id !== plan.id || active.planApproval.revision !== plan.revision) {
      active.planApproval = plan;
      active.project = { ...active.project, planApproval: plan, refreshedAt: Date.now() };
      this.emitEvent({ type: "plan_approval_updated", plan });
      this.emitEvent({ type: "project_updated", project: active.project });
    }
    return plan;
  }

  async stopSubagent(id: string, _background: boolean): Promise<{ stopped: true }> {
    if (!id.trim()) throw new Error("缺少子 Agent 标识。");
    const reply = await this.subagentRpc("stop", id.trim());
    const activity = isRecord(reply) && isRecord(reply.activity) ? subagentActivitiesFromPayload({ activities: [reply.activity] })[0] : undefined;
    if (!activity) throw new Error("子 Agent 停止响应缺少运行状态。");
    this.mergeSubagentActivities([activity]);
    return { stopped: true };
  }

  async resumeSubagent(id: string): Promise<{ resumed: true }> {
    if (!id.trim()) throw new Error("缺少子 Agent 标识。");
    const reply = await this.subagentRpc("resume", id.trim());
    const activity = isRecord(reply) && isRecord(reply.activity) ? subagentActivitiesFromPayload({ activities: [reply.activity] })[0] : undefined;
    if (activity) this.mergeSubagentActivities([activity]);
    return { resumed: true };
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
          active.activeAssistantMessage = undefined;
          this.emitEvent({ type: "run_state", running: false });
          void this.snapshot().then((snapshot) => this.emitEvent({ type: "session_snapshot", snapshot }));
          this.scheduleProjectRefresh();
          void this.listSessions(active.cwd);
          break;
        case "compaction_start":
          active.summaryActivity = {
            id: `compaction-${active.sessionRevision}-${Date.now()}`,
            kind: "compaction",
            status: "running",
            timestamp: Date.now(),
            active: true,
            reason: event.reason,
          };
          this.publishRuntimeInspection(active);
          break;
        case "compaction_end": {
          const leaf = active.session.sessionManager.getLeafEntry();
          const activeIds = new Set(active.session.sessionManager.getBranch().map((entry) => entry.id));
          const persisted = leaf ? summaryEventFromEntry(leaf, activeIds) : undefined;
          if (event.result) {
            active.summaryActivity = {
              ...(persisted ?? active.summaryActivity ?? {
                id: `compaction-${active.sessionRevision}-${Date.now()}`,
                kind: "compaction" as const,
                timestamp: Date.now(),
                active: true,
              }),
              status: "succeeded",
              reason: event.reason,
              summary: event.result.summary,
              tokensBefore: event.result.tokensBefore,
              estimatedTokensAfter: event.result.estimatedTokensAfter,
              firstKeptEntryId: event.result.firstKeptEntryId,
              willRetry: event.willRetry,
            };
          } else {
            active.summaryActivity = {
              ...(active.summaryActivity ?? {
                id: `compaction-${active.sessionRevision}-${Date.now()}`,
                kind: "compaction" as const,
                timestamp: Date.now(),
                active: true,
              }),
              status: event.aborted ? "aborted" : "failed",
              reason: event.reason,
              error: event.errorMessage,
              willRetry: event.willRetry,
            };
          }
          this.publishRuntimeInspection(active);
          void this.snapshot().then((snapshot) => this.emitEvent({ type: "session_snapshot", snapshot }));
          break;
        }
        case "summarization_retry_scheduled":
          active.summaryActivity = {
            ...(active.summaryActivity ?? {
              id: `summary-retry-${active.sessionRevision}-${Date.now()}`,
              kind: "compaction" as const,
              status: "running" as const,
              timestamp: Date.now(),
              active: true,
            }),
            status: "running",
            retryAttempt: event.attempt,
            retryMaxAttempts: event.maxAttempts,
            error: event.errorMessage,
          };
          this.publishRuntimeInspection(active);
          break;
        case "summarization_retry_attempt_start":
          active.summaryActivity = {
            ...(active.summaryActivity ?? {
              id: `summary-retry-${active.sessionRevision}-${Date.now()}`,
              kind: event.source === "branchSummary" ? "branch_summary" as const : "compaction" as const,
              timestamp: Date.now(),
              active: true,
            }),
            status: "running",
            ...(event.source === "compaction" ? { reason: event.reason } : {}),
          };
          this.publishRuntimeInspection(active);
          break;
        case "entry_appended":
          if (event.entry.type === "message" && isRecord(event.entry.message) && event.entry.message.role === "user") {
            const correlatedId = active.activeUserId ?? active.lastUserId;
            if (correlatedId) active.messageIds.set(event.entry.message, correlatedId);
            active.lastUserId = undefined;
          }
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
          if (event.entry.type === "compaction" || event.entry.type === "branch_summary") {
            active.sessionRevision += 1;
            const activeIds = new Set(active.session.sessionManager.getBranch().map((entry) => entry.id));
            active.summaryActivity = summaryEventFromEntry(event.entry, activeIds);
            this.publishRuntimeInspection(active);
          }
          break;
        case "session_info_changed":
          void this.snapshot().then((snapshot) => this.emitEvent({ type: "session_snapshot", snapshot }));
          void this.listSessions(active.cwd);
          break;
        case "message_start": {
          const raw = event.message as unknown;
          const role = isRecord(raw) ? stringValue(raw.role) : "message";
          const clientMessageId = role === "user" ? active.pendingUserMessageIds.shift() : undefined;
          const id = clientMessageId || this.messageId(raw, role || "message");
          if (clientMessageId && isRecord(raw)) active.messageIds.set(raw, clientMessageId);
          const order = active.nextTimelineOrder++;
          if (role === "user") {
            active.activeUserId = id;
            active.activeUserOrder = order;
          } else if (role === "assistant") {
            active.activeAssistantId = id;
            active.activeAssistantOrder = order;
          }
          const mapped = mapMessage(raw, id, order);
          if (mapped && mapped.role !== "tool") {
            this.emitEvent({ type: "message_started", message: mapped, revision: ++active.messageRevision });
          }
          if (mapped && mapped.role === "assistant") {
            active.activeAssistantMessage = { ...mapped, status: "running" };
          }
          if (role === "user") void this.listSessions(active.cwd);
          break;
        }
        case "message_update": {
          const update = event.assistantMessageEvent;
          const id = active.activeAssistantId ?? this.messageId(event.message as unknown, "assistant");
          active.activeAssistantId = id;
          const mapped = mapMessage(event.message as unknown, id, active.activeAssistantOrder ?? active.nextTimelineOrder);
          if (mapped && mapped.role === "assistant") {
            active.activeAssistantMessage = { ...mapped, status: "running" };
          }
          if (update.type === "text_delta") {
            this.emitEvent({ type: "message_delta", id, field: "text", delta: update.delta, revision: ++active.messageRevision });
          } else if (update.type === "thinking_delta") {
            this.emitEvent({ type: "message_delta", id, field: "thinking", delta: update.delta, revision: ++active.messageRevision });
          }
          break;
        }
        case "message_end": {
          const raw = event.message as unknown;
          const role = isRecord(raw) ? stringValue(raw.role) : "message";
          const id = role === "user" && active.activeUserId
            ? active.activeUserId
            : role === "assistant" && active.activeAssistantId
              ? active.activeAssistantId
              : this.messageId(raw, role || "message");
          const order = role === "user" && active.activeUserOrder !== undefined
            ? active.activeUserOrder
            : role === "assistant" && active.activeAssistantOrder !== undefined
              ? active.activeAssistantOrder
              : active.nextTimelineOrder++;
          const mapped = mapMessage(raw, id, order);
          if (mapped && mapped.role !== "tool") {
            this.emitEvent({ type: "message_finished", message: mapped, revision: ++active.messageRevision });
          }
          if (role === "user") {
            active.lastUserId = id;
            active.activeUserId = undefined;
            active.activeUserOrder = undefined;
          } else if (role === "assistant") {
            active.activeAssistantMessage = undefined;
          }
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
          if (event.toolName === "subagent" && (!stringValue(args.action) || args.action === "run" || args.action === "resume")) {
            const task = stringValue(args.task);
            const agent = stringValue(args.agent) || "子 Agent";
            const background = args.background === true;
            const placeholder: SubagentActivity = {
              id: `${tool.id}:0`,
              runId: tool.id,
              parentToolId: tool.id,
              index: 0,
              agent,
              task: task || undefined,
              model: stringValue(args.model) || undefined,
              status: "running",
              background,
              controlReady: false,
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
            const details = isRecord(event.partialResult) ? event.partialResult.details : undefined;
            const activity = subagentActivityFromDetails(details, tool.id);
            if (activity) {
              active.subagents.delete(`${tool.id}:0`);
              this.mergeSubagentActivities([activity]);
            }
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
          if (event.toolName === "plan") {
            const details = isRecord(event.result) ? event.result.details : undefined;
            const approval = planApprovalState(isRecord(details) ? details.plan ?? details : undefined);
            if (approval) {
              active.planApproval = approval;
              active.project = { ...active.project, planApproval: approval, refreshedAt: Date.now() };
              this.emitEvent({ type: "plan_approval_updated", plan: approval });
            }
          }
          if (event.toolName === "subagent") {
            const details = isRecord(event.result) ? event.result.details : undefined;
            const activity = subagentActivityFromDetails(details, tool.id);
            if (activity) {
              active.subagents.delete(`${tool.id}:0`);
              this.mergeSubagentActivities([activity]);
            } else {
              const placeholder = active.subagents.get(`${tool.id}:0`);
              if (placeholder) {
                const updated = {
                  ...placeholder,
                  status: event.isError ? "failed" : placeholder.background ? "running" : "completed",
                  controlReady: false,
                  error: event.isError ? tool.output : placeholder.error,
                  durationMs: Date.now() - placeholder.updatedAt,
                  updatedAt: Date.now(),
                } satisfies SubagentActivity;
                active.subagents.set(placeholder.id, updated);
                this.publishSubagents();
              }
            }
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

  async prompt(text: string, images?: PromptImage[], clientMessageId?: string): Promise<{ accepted: true }> {
    const active = this.requireActive();
    if (this.modelTransition) await this.modelTransition;
    const prompt = text.trim() || (images?.length ? "请查看附加的图片。" : "");
    if (!prompt) throw new Error("消息不能为空。");
    if (prompt === "/memory" && !images?.length) return this.runMemoryNow();
    if (!active.session.isStreaming) {
      if (this.promptStarting) throw new Error("上一条消息正在启动，请稍候。");
      this.promptStarting = true;
    }
    if (active.session.isStreaming) return this.steer(prompt, images, clientMessageId);
    try {
      const prepared = await preparePromptImages(images);
      const expandedPrompt = prepared.hints ? `${prompt}\n\n${prepared.hints}` : prompt;

      const hasUserMessage = active.session.messages.some((message) => isRecord(message) && message.role === "user");
      if (!hasUserMessage) active.session.setSessionName(titleFromText(prompt));

      this.queueClientMessage(active, clientMessageId);
      void active.session.prompt(expandedPrompt, {
        images: prepared.images.length ? prepared.images.map(({ mimeType, data }) => ({ type: "image" as const, mimeType, data })) : undefined,
        preflightResult: () => { this.promptStarting = false; },
      }).catch((error) => {
        this.promptStarting = false;
        this.rejectClientMessage(active, clientMessageId);
        this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
        this.emitEvent({ type: "run_state", running: false });
      });
      return { accepted: true };
    } catch (error) {
      this.promptStarting = false;
      throw error;
    }
  }

  async rewindPrompt(entryId: string, text: string, images?: PromptImage[], clientMessageId?: string): Promise<{ accepted: true }> {
    const active = this.requireActive();
    if (this.modelTransition) await this.modelTransition;
    const prompt = text.trim() || (images?.length ? "请查看附加的图片。" : "");
    if (!prompt) throw new Error("消息不能为空。");
    if (active.session.isStreaming) throw new Error("请等待当前回复结束后再回溯。");
    if (this.promptStarting) throw new Error("上一条消息正在启动，请稍候。");
    this.promptStarting = true;
    try {
      const result = await active.session.navigateTree(entryId, { summarize: false });
      if (result.cancelled) throw new Error("未能回溯到所选消息。");
      active.sessionRevision += 1;
      active.summaryActivity = undefined;
      const prepared = await preparePromptImages(images);
      const expandedPrompt = prepared.hints ? `${prompt}\n\n${prepared.hints}` : prompt;
      const hasUserMessage = active.session.messages.some((message) => isRecord(message) && message.role === "user");
      if (!hasUserMessage) active.session.setSessionName(titleFromText(prompt));
      this.emitEvent({ type: "session_snapshot", snapshot: await this.snapshot() });
      // Session-scoped System Prompt, Skill, and MCP policies live on the active
      // Pi branch. Rewinding changes that branch, so refresh the right-hand
      // runtime inspector without blocking the new prompt on MCP discovery.
      void this.refreshRuntimeInspectionSources(active);
      this.queueClientMessage(active, clientMessageId);
      void active.session.prompt(expandedPrompt, {
        images: prepared.images.length ? prepared.images.map(({ mimeType, data }) => ({ type: "image" as const, mimeType, data })) : undefined,
        preflightResult: () => { this.promptStarting = false; },
      }).catch((error) => {
        this.promptStarting = false;
        this.rejectClientMessage(active, clientMessageId);
        this.emitEvent({ type: "runtime_error", message: errorMessage(error), detail: errorDetail(error) });
        this.emitEvent({ type: "run_state", running: false });
      });
      return { accepted: true };
    } catch (error) {
      this.promptStarting = false;
      throw error;
    }
  }

  async steer(text: string, images?: PromptImage[], clientMessageId?: string): Promise<{ accepted: true }> {
    const active = this.requireActive();
    if (this.modelTransition) await this.modelTransition;
    const prompt = text.trim() || (images?.length ? "请查看附加的图片。" : "");
    if (!prompt) throw new Error("消息不能为空。");
    const prepared = await preparePromptImages(images);
    const expandedPrompt = prepared.hints ? `${prompt}\n\n${prepared.hints}` : prompt;
    this.queueClientMessage(active, clientMessageId);
    try {
      await active.session.prompt(expandedPrompt, {
        images: prepared.images.length ? prepared.images.map(({ mimeType, data }) => ({ type: "image" as const, mimeType, data })) : undefined,
        streamingBehavior: "steer",
      });
    } catch (error) {
      this.rejectClientMessage(active, clientMessageId);
      throw error;
    }
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
      planApproval: active.planApproval,
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
      planApproval: active.planApproval,
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

  async snapshot(reconstructedState?: ReconstructedSessionState): Promise<SessionSnapshot> {
    const active = this.requireActive();
    const reconstructed = reconstructedState ?? this.reconstructState(active.session);
    const header = active.session.sessionManager.getHeader();
    const now = new Date();
    const sessionFile = active.session.sessionFile ?? "";
    let updatedAt = now.toISOString();
    if (sessionFile && existsSync(sessionFile)) {
      try {
        updatedAt = statSync(sessionFile).mtime.toISOString();
      } catch {
        // The session may be between an atomic write and rename; the live timestamp is sufficient.
      }
    }
    const firstUserMessage = reconstructed.messages.find((message) => message.role === "user");
    const summary: SessionSummary = {
      id: active.session.sessionId,
      path: sessionFile,
      cwd: active.cwd,
      title: active.session.sessionName || titleFromText(firstUserMessage?.text ?? ""),
      createdAt: header?.timestamp ?? now.toISOString(),
      updatedAt,
      messageCount: active.session.messages.length,
    };
    const messages = reconstructed.messages;
    if (active.activeAssistantMessage && !messages.some((message) => message.id === active.activeAssistantMessage!.id)) {
      const maxOrder = messages.reduce((max, message) => Math.max(max, message.order), -1);
      messages.push({ ...active.activeAssistantMessage, order: maxOrder + 1 });
    }
    const model = active.session.model;
    const usage = sessionUsage(active.session);
    active.responseMetrics = reconstructed.responseMetrics ?? active.responseMetrics;
    active.responseMetricsHistory = reconstructed.responseMetricsHistory;
    return {
      messageRevision: active.messageRevision,
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
      runtimeInspection: this.runtimeInspection(active),
      running: active.session.isStreaming,
    };
  }

  private runtimeInspection(active: ActiveSession): RuntimeInspectionSnapshot {
    const base = buildRuntimeInspection(
      active.session.sessionManager,
      active.sessionRevision,
      active.summaryActivity,
    );
    const messages: readonly unknown[] = active.session.isStreaming && active.bridgeState?.contextMessages?.length
      ? active.bridgeState.contextMessages
      : active.session.messages;
    const estimatedMessages = messages.reduce<number>((total, message) => {
      try {
        return total + estimateTokens(message as Parameters<typeof estimateTokens>[0]);
      } catch {
        return total + estimatedTextTokens(message);
      }
    }, 0);
    const activeToolNames = new Set(active.session.getActiveToolNames());
    const tools: RuntimeToolDefinition[] = active.session.getAllTools().map((tool) => {
      const source = tool.sourceInfo.source || tool.sourceInfo.path || "unknown";
      return {
        name: tool.name,
        description: tool.description,
        source,
        active: activeToolNames.has(tool.name),
        estimatedTokens: estimatedTextTokens({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          promptGuidelines: tool.promptGuidelines,
        }),
      };
    }).sort((left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name));
    const disabledSkills = new Set(active.bridgeState?.disabledSkills ?? []);
    const readSkills = new Set((active.bridgeState?.readSkills ?? []).map((path) => resolve(path)));
    const skills: RuntimeSkillState[] = (active.skillConfiguration?.skills ?? []).map((skill) => {
      const resolvedPath = resolve(skill.filePath);
      const sessionEnabled = skill.enabled && !disabledSkills.has(skill.filePath) && !disabledSkills.has(resolvedPath);
      return {
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        source: skill.source,
        globallyEnabled: skill.enabled,
        sessionEnabled,
        publishedToModel: sessionEnabled && !skill.disableModelInvocation,
        readInSession: readSkills.has(resolvedPath),
        estimatedMetadataTokens: estimatedTextTokens({
          name: skill.name,
          description: skill.description,
          location: skill.filePath,
        }),
      };
    });
    const effectiveSystemPrompt = active.bridgeState?.effectiveSystemPrompt || active.session.systemPrompt || undefined;
    const systemPromptTokens = effectiveSystemPrompt ? estimatedTextTokens(effectiveSystemPrompt) : undefined;
    const toolDefinitionTokens = tools.filter((tool) => tool.active).reduce((total, tool) => total + tool.estimatedTokens, 0);
    const usage = sessionUsage(active.session);
    const cacheDenominator = usage.tokenUsage.input + usage.tokenUsage.cacheRead + usage.tokenUsage.cacheWrite;
    const cacheHitRate = usage.tokenUsage.cacheRead > 0 && cacheDenominator > 0
      ? usage.tokenUsage.cacheRead / cacheDenominator
      : undefined;
    const sharedMemoryStatus = projectMemoryStatusByCwd.get(safeRealPath(active.cwd));
    const memoryStatus = memoryStatusForInspection(active.memoryStatus, sharedMemoryStatus);
    return {
      ...base,
      effectiveSystemPrompt,
      systemPromptOverride: Boolean(active.bridgeState?.systemPromptOverride),
      estimates: {
        systemPrompt: systemPromptTokens,
        toolDefinitions: toolDefinitionTokens || undefined,
        messages: estimatedMessages || undefined,
        total: usage.contextUsage?.tokens ?? (((systemPromptTokens ?? 0) + toolDefinitionTokens + estimatedMessages) || undefined),
      },
      cacheHitRate,
      tools,
      skills,
      mcp: active.mcpStatus,
      memory: memoryStatus ? hydrateProjectMemoryStatus(memoryStatus) : undefined,
      capabilities: {
        editSystemPrompt: true,
        removeOriginalSessionItems: false,
        removeOriginalSessionItemsReason: ORIGINAL_SESSION_MUTATION_UNSUPPORTED,
      },
    };
  }

  private publishRuntimeInspection(active: ActiveSession): void {
    this.emitEvent({ type: "runtime_inspection_updated", inspection: this.runtimeInspection(active) });
  }

  async dispose(): Promise<void> {
    if (this.projectRefreshTimer) clearTimeout(this.projectRefreshTimer);
    if (this.mcpReloadTimer) clearTimeout(this.mcpReloadTimer);
    if (this.resourceReloadTimer) clearTimeout(this.resourceReloadTimer);
    for (const flow of this.providerAuthFlows.values()) {
      const pending = this.clearProviderAuthPrompt(flow);
      flow.controller.abort();
      pending?.reject(new Error("运行时已关闭，订阅登录已取消。"));
    }
    this.providerAuthFlows.clear();
    if (this.active) {
      const active = this.active;
      this.active = undefined;
      active.unsubscribe();
      try {
        await shutdownAgentSession(active.session, "quit");
      } finally {
        active.eventBus.clear();
      }
    }
  }
}
