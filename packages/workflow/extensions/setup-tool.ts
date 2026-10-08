/**
 * The Agent's door to CoilCoil itself: what this app can do, plus doing it.
 *
 * One tool, four areas — deliberately. Configuring an MCP server is a config
 * edit, installing a skill is a file copy, and configuring a model/provider is
 * another settings-panel operation; what it lacks is *where* and *how*, plus
 * the half no file edit can do (reload the live session, run OAuth, refresh
 * upstream metadata). So `guide` serves that knowledge as text, and `mcp` /
 * `skill` / `model` run the very methods the settings panel uses, over an RPC
 * channel the runtime answers.
 * Nothing here touches config files directly: writing the file without the
 * reload leaves the Agent staring at the old world, and the removed/disabled
 * bookkeeping disagrees with the panel.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  readBundledDoc,
  setupGuide,
  summarizeBundledDoc,
  type GuideTopic,
} from "./setup-guide.ts";

export const SETUP_RPC_REQUEST_CHANNEL = "coilcoil:setup:rpc:v1:request";
export const SETUP_RPC_REPLY_PREFIX = "coilcoil:setup:rpc:v1:reply:";
export const COILCOIL_TOOL_NAME = "coilcoil";
const SETUP_RPC_TIMEOUT_MS = 120_000;
const DOC_PREVIEW_CHARS = 8_000;

const ModelCostTierParams = Type.Object({
  inputTokensAbove: Type.Number(),
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
});

const ModelCostParams = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  tiers: Type.Optional(Type.Array(ModelCostTierParams)),
});

const ModelDefinitionParams = Type.Object({
  id: Type.String({ description: "Model ID, sent to the provider verbatim" }),
  name: Type.Optional(Type.String({ description: "Display name" })),
  api: Type.Optional(Type.String({ description: "Request protocol this model overrides to use" })),
  baseUrl: Type.Optional(Type.String({ description: "Base URL this model overrides to use" })),
  reasoning: Type.Optional(Type.Boolean({ description: "Whether the model supports thinking / reasoning" })),
  thinkingLevelMap: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]), { description: "Mapping from thinking level to the upstream effort; null means the level is unsupported" })),
  input: Type.Optional(Type.Array(StringEnum(["text", "image"]), { description: "Input modalities; include image to support images" })),
  contextWindow: Type.Optional(Type.Number({ description: "Maximum context window in tokens" })),
  maxTokens: Type.Optional(Type.Number({ description: "Maximum output tokens" })),
  cost: Type.Optional(ModelCostParams),
  samplingParams: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Sampling parameters such as temperature and top_p" })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Model-specific request headers; send an existing sensitive value back as •••••• to leave it unchanged" })),
  compat: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Pi provider compatibility parameters" })),
}, { additionalProperties: false });

const ModelCredentialParams = Type.Object({
  method: Type.String({ description: "Method ID from credential.methods" }),
  values: Type.Record(Type.String(), Type.String(), { description: "Credential fields; fill them in as the user asks" }),
  preserveFields: Type.Optional(Type.Array(Type.String(), { description: "Configured credential fields that are left empty but still kept" })),
});

const ModelProviderParams = Type.Object({
  id: Type.String({ description: "Provider ID; only letters, digits, dots, hyphens and underscores" }),
  name: Type.Optional(Type.String({ description: "Provider display name" })),
  baseUrl: Type.Optional(Type.String({ description: "Provider base URL" })),
  api: Type.Optional(Type.String({ description: "Request protocol ID; pick one from supportedApis returned by model op=list first" })),
  oauth: Type.Optional(StringEnum(["radius"], { description: "Subscription OAuth provider type" })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Provider request headers; use •••••• to keep a sensitive value as it is" })),
  compat: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Provider compatibility JSON" })),
  authHeader: Type.Optional(Type.Boolean({ description: "Whether Pi writes the Authorization request header automatically" })),
  apiKeyReference: Type.Optional(Type.String({ description: "Optional source of the API key; pass an empty string to clear it" })),
  preserveApiKeyReference: Type.Optional(Type.Boolean({ description: "Whether to keep the key reference already in models.json when no new reference is given" })),
  disabled: Type.Optional(Type.Boolean({ description: "Keep the configuration but hide the provider from the model list" })),
  replaceModels: Type.Optional(Type.Boolean({ description: "Whether models replaces Pi's built-in model catalog" })),
  models: Type.Optional(Type.Array(ModelDefinitionParams, { description: "The provider's model catalog; merged by id incrementally by default" })),
  modelsMode: Type.Optional(StringEnum(["merge", "replace"], { description: "How models is applied; merge by default" })),
  removeModels: Type.Optional(Type.Array(Type.String(), { description: "Remove existing models by model ID" })),
  modelOverrides: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Runtime overrides keyed by model ID" })),
  apiKey: Type.Optional(Type.String({ description: "API key; use it for the provider configuration as the user asks" })),
  credential: Type.Optional(ModelCredentialParams),
}, { additionalProperties: false, description: "Incremental provider configuration for model op=save; fields that are not given stay unchanged" });

const ModelRequestParams = Type.Object({
  baseUrl: Type.Optional(Type.String()),
  api: Type.Optional(Type.String()),
  apiKey: Type.Optional(Type.String({ description: "API key; use it for this fetch or test as the user asks" })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  provider: Type.Optional(Type.String({ description: "Existing provider ID; when apiKey is omitted, the credentials already configured for that provider are used" })),
  modelId: Type.Optional(Type.String({ description: "Model ID used when testing the connection" })),
});

const WsConfigurationParams = Type.Object({
  baseUrl: Type.String({ description: "OpenAI Responses WS address" }),
  apiKey: Type.Optional(Type.String({ description: "API key; use it for the WS configuration as the user asks" })),
  preserveApiKey: Type.Optional(Type.Boolean()),
  fast: Type.Optional(Type.Boolean()),
});

export const CoilcoilParams = Type.Object({
  area: StringEnum(["guide", "mcp", "skill", "model"], {
    description: "guide: read the tutorials first; mcp: inspect, configure, edit and connect MCP servers; skill: list, install, enable and disable Skills; model: configure model providers, model capabilities, metadata and subscription sign-in",
  }),
  op: Type.Optional(Type.String({
    description: "guide: skill / mcp / auth / model / read_doc; mcp: list/save/get_json/save_json/remove/enable/disable/discover/import/parse_snippet/connect/auth_start/auth_await_each/auth_finish/auth_cancel/auth_complete/logout/session_enable/session_disable; skill: list/install/enable/disable/remove/delete/session_enable/session_disable; model: list/save/remove/enable/disable/fetch_models/catalog/test/auth_start/auth_status/auth_await/auth_respond/auth_cancel/logout/ws_get/ws_save",
  })),
  topic: Type.Optional(Type.String({ description: "When area=guide and op is not read_doc: skill / mcp / auth / model" })),
  providerId: Type.Optional(Type.String({ description: "Model provider ID; name is also accepted for compatibility" })),
  provider: Type.Optional(ModelProviderParams),
  request: Type.Optional(ModelRequestParams),
  modelIds: Type.Optional(Type.Array(Type.String(), { description: "Array of model IDs for model op=catalog" })),
  refresh: Type.Optional(Type.Boolean({ description: "Whether model op=catalog ignores the 24-hour cache and fetches again" })),
  flowId: Type.Optional(Type.String({ description: "model OAuth flow ID" })),
  promptId: Type.Optional(Type.String({ description: "ID of the current interactive prompt of the model OAuth flow" })),
  value: Type.Optional(Type.String({ description: "Answer to the current prompt of the model OAuth flow" })),
  revision: Type.Optional(Type.Number({ description: "The revision last received by model op=auth_await" })),
  timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait in milliseconds for model op=auth_await" })),
  ws: Type.Optional(WsConfigurationParams),
  doc: Type.Optional(Type.String({ description: "When area=guide + op=read_doc: the document name, such as architecture or readme" })),
  name: Type.Optional(Type.String({ description: "MCP server name (used by connect, authentication, logout, enable and remove)" })),
  filePath: Type.Optional(Type.String({ description: "Skill file path (used by enable, disable, remove and delete)" })),
  path: Type.Optional(Type.String({ description: "Local directory of the skill (used by install)" })),
  // 字段必须逐个写出来。之前这里是 Type.Any，它序列化成一个空 schema `{}`，
  // 模型看不出要填什么、provider 那边也容易直接把这个参数丢掉——结果就是 save
  // 永远收到「缺少 server」，唯一合规的配置通道是坏的。
  server: Type.Optional(Type.Object({
    name: Type.Optional(Type.String({ description: "Server name; only letters, digits, dots, underscores and hyphens" })),
    scope: Type.Optional(StringEnum(["global", "project"], { description: "Default global; project applies to the current workspace only" })),
    transport: Type.Optional(StringEnum(["stdio", "http"], { description: "stdio needs command; http needs url" })),
    command: Type.Optional(Type.String({ description: "Start command for stdio, such as npx" })),
    args: Type.Optional(Type.Array(Type.String(), { description: "Command arguments for stdio" })),
    env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Environment variables for stdio; use a ${VAR} placeholder for sensitive values" })),
    cwd: Type.Optional(Type.String({ description: "Working directory for stdio" })),
    url: Type.Optional(Type.String({ description: "Server address for http" })),
    headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Request headers for http; use a ${VAR} placeholder for sensitive values" })),
    auth: Type.Optional(Type.Union([StringEnum(["oauth", "bearer"]), Type.Literal(false)], { description: "oauth authenticates through the browser; false means explicitly no authentication" })),
    bearerTokenEnv: Type.Optional(Type.String({ description: "Name of the environment variable that holds the token; if a token is written in directly, tell the user it is now exposed and recommend rotating it" })),
    lifecycle: Type.Optional(StringEnum(["lazy", "eager", "keep-alive"], { description: "Default lazy: connect when used, release when idle" })),
    idleTimeout: Type.Optional(Type.Number({ description: "Minutes of idleness before disconnecting" })),
    requestTimeoutMs: Type.Optional(Type.Number({ description: "Timeout of a single call in milliseconds" })),
    exposeResources: Type.Optional(Type.Boolean({ description: "Whether to expose this server's resources to the agent" })),
    directTools: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())], { description: "true or a list of tool names: register these tools directly with the model (they cost tokens on every turn, so use sparingly)" })),
    excludeTools: Type.Optional(Type.Array(Type.String(), { description: "Names of tools not to expose" })),
    debug: Type.Optional(Type.Boolean({ description: "Turn on debug logging for this server" })),
    disabled: Type.Optional(Type.Boolean({ description: "Disable the server right after saving" })),
  }, {
    additionalProperties: true,
    description: "Server definition for mcp save; give at least name+command for stdio and name+url for http",
  })),
  text: Type.Optional(Type.String({ description: "Configuration JSON for parse_snippet; the full mcp.json for save_json; the pasted callback content for auth_complete" })),
  input: Type.Optional(Type.String({ description: "Alias for the callback content pasted for auth_complete; use either this or text" })),
  enabled: Type.Optional(Type.Boolean({ description: "Switch for enable/disable/session_enable/session_disable; inferred from the op name when omitted" })),
  scope: Type.Optional(StringEnum(["global", "project"], { description: "Scope for save/remove; default global" })),
  previousName: Type.Optional(Type.String({ description: "The old name, when saving under a new name" })),
  servers: Type.Optional(Type.Array(Type.Object({
    origin: Type.String({ description: "Source tool: cursor / claude-code / claude-desktop / codex / opencode / windsurf / vscode" }),
    name: Type.String({ description: "Server name within that source" }),
  }), { description: "Servers to bring over on import, taken from the result of discover" })),
  imports: Type.Optional(Type.Array(Type.String(), { description: "List of sources to enable for enable_imports" })),
});

type CoilcoilParamsValue = {
  area: "guide" | "mcp" | "skill" | "model";
  op?: string;
  topic?: string;
  doc?: string;
  name?: string;
  providerId?: string;
  provider?: unknown;
  request?: unknown;
  modelIds?: unknown;
  refresh?: boolean;
  flowId?: string;
  promptId?: string;
  value?: string;
  revision?: number;
  timeoutMs?: number;
  ws?: unknown;
  filePath?: string;
  path?: string;
  server?: unknown;
  text?: string;
  input?: string;
  enabled?: boolean;
  scope?: string;
  previousName?: string;
  servers?: unknown;
  imports?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textResult(text: string, details: Record<string, unknown>, isError = false): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError: boolean;
} {
  return { content: [{ type: "text", text }], details, isError };
}

function workflowDir(): string {
  // The document shelf lives next to the workflow *package*, not the agent
  // *data* directory: <repo>/packages/workflow. getAgentDir() points at the
  // data dir, so resolve the package through the extension file itself.
  try {
    const here = fileURLToPath(import.meta.url);
    return resolve(here, "..", "..");
  } catch {
    return "";
  }
}

function setupRequestFrom(raw: unknown): { requestId?: string; success?: boolean; data?: unknown; error?: unknown } {
  return isRecord(raw) ? raw as { requestId?: string; success?: boolean; data?: unknown; error?: unknown } : {};
}

/**
 * Ask the runtime to run one of its own configuration methods.
 *
 * Same shape as the subagent/plan RPC calls: emit a request, wait for the
 * per-request reply channel, time out out loud. Auth waits ride on this too,
 * which is why the timeout is minutes rather than seconds.
 */
async function setupRpc(
  pi: ExtensionAPI,
  method: string,
  params: Record<string, unknown> | undefined,
  cwd: string | undefined,
): Promise<unknown> {
  const requestId = `coilcoil-setup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const replyChannel = `${SETUP_RPC_REPLY_PREFIX}${requestId}`;
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      callback();
    };
    const unsubscribe = pi.events.on(replyChannel, (raw) => {
      const reply = setupRequestFrom(raw);
      if (!isRecord(raw)) return;
      if (reply.success === true) {
        finish(() => resolvePromise(reply.data));
        return;
      }
      const message = isRecord(reply.error) && typeof reply.error.message === "string"
        ? reply.error.message
        : "配置请求失败。";
      finish(() => rejectPromise(new Error(message)));
    });
    const timer = setTimeout(
      () => finish(() => rejectPromise(new Error("配置请求超时：运行时没有应答。"))),
      SETUP_RPC_TIMEOUT_MS,
    );
    try {
      pi.events.emit(SETUP_RPC_REQUEST_CHANNEL, {
        version: 1,
        requestId,
        method,
        params,
        cwd,
      });
    } catch (error) {
      finish(() => rejectPromise(error instanceof Error ? error : new Error(String(error))));
    }
  });
}

function renderMcpConfiguration(configuration: unknown): string {
  if (!isRecord(configuration) || !Array.isArray(configuration.servers)) return "没能读到 MCP 配置。";
  const servers = configuration.servers as Array<Record<string, unknown>>;
  if (!servers.length) return "当前没有配任何 MCP Server。用 op=save 按 guide 里 mcp 那节配第一个。";
  const lines = servers.map((server) => {
    const name = typeof server.name === "string" ? server.name : "?";
    const transport = server.transport === "http" ? String(server.url ?? "http") : String(server.command ?? "stdio");
    const scope = server.scope === "project" ? "项目" : "全局";
    const state = server.disabled === true ? "已停用" : "启用中";
    return `- ${name}（${scope} · ${state} · ${transport}）`;
  });
  return ["已配置的 MCP Server：", ...lines].join("\n");
}

function renderSkillConfiguration(configuration: unknown): string {
  if (!isRecord(configuration) || !Array.isArray(configuration.skills)) return "没能读到 Skill 配置。";
  const skills = configuration.skills as Array<Record<string, unknown>>;
  if (!skills.length) return "当前没有装任何 Skill。用 op=install 按 guide 里 skill 那节从本地目录装。";
  const lines = skills.map((skill) => {
    const name = typeof skill.name === "string" ? skill.name : "?";
    const source = typeof skill.source === "string" ? skill.source : "";
    const state = skill.enabled === false ? "已停用" : "启用中";
    const path = typeof skill.filePath === "string" ? skill.filePath : "";
    return `- ${name}（${state}${source ? ` · ${source}` : ""}）${path ? `\n  ${path}` : ""}`;
  });
  return ["已安装的 Skill：", ...lines].join("\n");
}

/**
 * Say what a session toggle actually did.
 *
 * The old answer was 「做完了，但运行时没说什么」, which is the same sentence
 * whether it worked or not — and it was printed while trying to session-enable
 * a server that is disabled in the configuration, where the toggle genuinely
 * cannot help: session state only hides an available server for one
 * conversation, it does not override 停用.
 */
export function sessionMcpText(enabled: boolean, name: unknown, data: unknown): string {
  const serverName = typeof name === "string" && name.trim() ? name.trim() : "该 Server";
  const inspection = isRecord(data) ? (data as { inspection?: unknown }).inspection : undefined;
  const mcp = isRecord(inspection) ? (inspection as { mcp?: unknown }).mcp : undefined;
  const servers = isRecord(mcp) && Array.isArray((mcp as { servers?: unknown }).servers)
    ? (mcp as { servers: Array<Record<string, unknown>> }).servers
    : undefined;
  const server = servers?.find((entry) => entry.name === serverName);
  if (!server) {
    return `MCP 列表里没有「${serverName}」，会话级开关无处可施。先用 op=list 核对名字。`;
  }
  if (enabled && server.disabled === true) {
    return `「${serverName}」在配置里是停用状态，会话级开关救不回来——它只管「这次对话里临时藏起来」。要真的启用，用 op=enable（会写进配置并 reload）。`;
  }
  if (enabled && server.sessionDisabled === true) {
    return `「${serverName}」仍在当前会话被藏着，这次恢复没有生效，请当成失败处理。`;
  }
  return enabled
    ? `「${serverName}」在当前会话恢复可见（配置没动）。`
    : `「${serverName}」在当前会话已停用（配置没动，换个会话就回来）。`;
}

function renderSnippets(snippets: unknown): string {
  if (!Array.isArray(snippets) || !snippets.length) return "这段配置里没认出 MCP 服务器：需要 command（stdio）或 url（HTTP）。";
  return [
    `认出 ${snippets.length} 个服务器，确认后用 mcp op=save 逐个保存：`,
    ...snippets.map((entry, index) => {
      if (!isRecord(entry)) return `${index + 1}. （无法解析）`;
      const name = typeof entry.name === "string" ? entry.name : "（还没起名，save 时补一个 name）";
      const how = entry.transport === "http" ? String(entry.url ?? "") : String(entry.command ?? "");
      return `${index + 1}. ${name} · ${String(entry.transport ?? "?")} · ${how}`;
    }),
  ].join("\n");
}

/** `op` aliases: what people actually type, mapped to the runtime method. */
export function resolveMcpMethod(op: string): string | undefined {
  const normalized = op.trim().toLowerCase();
  const table: Record<string, string> = {
    list: "mcp_list",
    save: "mcp_save_server",
    get_json: "mcp_get_json",
    save_json: "mcp_save_json",
    remove: "mcp_remove",
    delete: "mcp_remove",
    enable: "mcp_set_enabled",
    disable: "mcp_set_enabled",
    discover: "mcp_discover",
    import: "mcp_import",
    enable_imports: "mcp_enable_imports",
    parse_snippet: "mcp_parse_snippet",
    parse: "mcp_parse_snippet",
    connect: "mcp_connect",
    check: "mcp_connect",
    auth_start: "mcp_auth_start",
    auth: "mcp_auth_start",
    auth_await_each: "mcp_auth_await_callback",
    auth_await_callback: "mcp_auth_await_callback",
    auth_finish: "mcp_auth_finish",
    auth_await: "mcp_auth_await",
    auth_cancel: "mcp_auth_cancel",
    auth_complete: "mcp_auth_complete",
    logout: "mcp_logout",
    session_enable: "mcp_set_session_enabled",
    session_disable: "mcp_set_session_enabled",
    // 动宾顺序反过来的那一半人会写成这样，而且教程曾经就是这么写的。
    enable_session: "mcp_set_session_enabled",
    disable_session: "mcp_set_session_enabled",
  };
  return table[normalized];
}

/** Whether an op name asks for "off", so `enabled` rarely has to be spelled out. */
export function isDisableOp(op: string): boolean {
  return /^(disable|session_disable|disable_session)$/.test(op.trim().toLowerCase());
}

/**
 * What just happened, in the words of the operation that happened.
 *
 * Every write used to end with 「装完自动 reload」 — including deletions, which
 * read as if the delete had installed something. On top of a stale list that
 * was two wrong signals in one answer.
 */
export function skillDoneText(method: string, enabled: boolean): string {
  if (method === "skill_list") return "";
  if (method === "skill_install") return "\n\n已装好并 reload，当前会话立刻生效。";
  if (method === "skill_set_enabled") return `\n\n已${enabled ? "启用" : "停用"}并 reload，上面列表就是改完的状态。`;
  if (method === "skill_remove") {
    return "\n\n已从列表里移除并 reload。文件还在磁盘上：用 op=enable 加同一个 filePath 可以恢复，要连文件一起删就用 op=delete。";
  }
  if (method === "skill_delete") return "\n\n已删除目录和配置记录并 reload，磁盘上不再留残留。";
  if (method === "skill_remove_path") return "\n\n已移除该技能目录并 reload。";
  return "\n\n已生效并 reload。";
}

export function resolveSkillMethod(op: string): string | undefined {
  const normalized = op.trim().toLowerCase();
  const table: Record<string, string> = {
    list: "skill_list",
    install: "skill_install",
    add: "skill_install",
    enable: "skill_set_enabled",
    disable: "skill_set_enabled",
    restore: "skill_set_enabled",
    remove: "skill_remove",
    hide: "skill_remove",
    delete: "skill_delete",
    remove_path: "skill_remove_path",
    session_enable: "skill_set_session_enabled",
    session_disable: "skill_set_session_enabled",
    enable_session: "skill_set_session_enabled",
    disable_session: "skill_set_session_enabled",
  };
  return table[normalized];
}

export function resolveModelMethod(op: string): string | undefined {
  const normalized = op.trim().toLowerCase();
  const table: Record<string, string> = {
    list: "model_list",
    get: "model_list",
    save: "model_save",
    add: "model_save",
    remove: "model_remove",
    delete: "model_remove",
    enable: "model_set_enabled",
    disable: "model_set_enabled",
    fetch: "model_fetch_models",
    fetch_models: "model_fetch_models",
    catalog: "model_catalog",
    metadata: "model_catalog",
    enrich: "model_catalog",
    test: "model_test",
    connect: "model_test",
    auth_start: "model_auth_start",
    login: "model_auth_start",
    auth_status: "model_auth_status",
    login_status: "model_auth_status",
    auth_await: "model_auth_await",
    login_await: "model_auth_await",
    auth_respond: "model_auth_respond",
    login_respond: "model_auth_respond",
    auth_cancel: "model_auth_cancel",
    login_cancel: "model_auth_cancel",
    logout: "model_logout",
    ws_get: "model_ws_get",
    ws_save: "model_ws_save",
  };
  return table[normalized];
}

function renderModelConfiguration(configuration: unknown): string {
  if (!isRecord(configuration) || !Array.isArray(configuration.providers)) return "没能读到模型服务商配置。";
  const providers = configuration.providers as Array<Record<string, unknown>>;
  const summary = providers.map((provider) => {
    const id = typeof provider.id === "string" ? provider.id : "?";
    const name = typeof provider.name === "string" ? provider.name : id;
    const models = Array.isArray(provider.models) ? provider.models.length : 0;
    const state = provider.disabled === true ? "已停用" : "启用中";
    const auth = provider.authType === "oauth" ? "订阅已登录" : provider.apiKeyConfigured === true ? "凭据已配置" : "未配置凭据";
    const source = typeof provider.source === "string" ? provider.source : "?";
    return `- ${name}（${id} · ${source} · ${state} · ${auth} · ${models} 个模型）`;
  });
  const serialized = JSON.stringify(configuration, null, 2);
  return [
    "已配置的模型服务商：",
    ...(summary.length ? summary : ["- 当前没有服务商配置。"]),
    "",
    "完整配置（凭据和敏感请求头已由运行时掩码）：",
    "```json",
    serialized ?? "{}",
    "```",
  ].join("\n");
}

function renderModelResult(data: unknown, operation: string): string {
  if (!isRecord(data)) return `${operation} 没有得到运行时回应，请当成没做成。`;
  const result = data.result;
  if (isRecord(result) && isRecord(result.configuration)) return `${renderModelConfiguration(result.configuration)}\n\n已${operation}并 reload，Agent 侧已生效。`;
  if (isRecord(data.configuration)) return `${renderModelConfiguration(data.configuration)}\n\n已${operation}并 reload，Agent 侧已生效。`;
  return JSON.stringify(result ?? data, null, 2) ?? `${operation} 已完成。`;
}

function renderModelCatalog(data: unknown): string {
  const metadata = isRecord(data) ? data.metadata : undefined;
  return [
    "模型元数据（来源优先级：models.dev → OpenRouter → LiteLLM）：",
    "```json",
    JSON.stringify(metadata ?? data, null, 2) ?? "{}",
    "```",
  ].join("\n");
}

function renderModelFetch(data: unknown): string {
  const result = isRecord(data) ? data.result : undefined;
  const metadata = isRecord(data) ? data.metadata : undefined;
  return [
    "上游模型列表和已匹配的元数据：",
    "```json",
    JSON.stringify({ models: result, metadata }, null, 2) ?? "{}",
    "```",
    "需要写入服务商时，把 models 里的 id 和 metadata 字段整理成 model op=save 的 provider.models；已有模型未提供的字段会保留。",
  ].join("\n");
}

function renderModelAuth(data: unknown): string {
  const result = isRecord(data) && isRecord(data.result) ? data.result : data;
  if (!isRecord(result)) return "订阅登录没有得到状态。";
  const state = isRecord(result.state) ? result.state : result;
  const status = typeof state.status === "string" ? state.status : "unknown";
  const flowId = typeof state.flowId === "string" ? state.flowId : "（无 flowId）";
  const lines = [`订阅登录状态：${status} · flowId=${flowId}`];
  if (typeof result.revision === "number") lines.push(`revision=${result.revision}`);
  if (typeof state.message === "string" && state.message) lines.push(state.message);
  if (isRecord(state.authUrl) && typeof state.authUrl.url === "string") lines.push(`浏览器授权链接：${state.authUrl.url}`);
  if (isRecord(state.deviceCode)) lines.push(`设备码：${String(state.deviceCode.userCode ?? "")}；地址：${String(state.deviceCode.verificationUri ?? "")}`);
  if (isRecord(state.prompt)) {
    lines.push(`需要用户输入：${String(state.prompt.message ?? "")}`);
    lines.push(`下一步用 op=auth_respond，传 flowId=${flowId}、promptId=${String(state.prompt.id ?? "")} 和 value。`);
  }
  if (typeof state.error === "string" && state.error) lines.push(`错误：${state.error}`);
  if (status === "authorizing" || status === "starting") lines.push(`下一步用 op=auth_await，传 flowId=${flowId} 和上面的 revision 等待变化。`);
  return lines.join("\n");
}

async function executeModel(
  pi: ExtensionAPI,
  params: CoilcoilParamsValue,
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError: boolean }> {
  const op = (params.op ?? "list").trim();
  const method = resolveModelMethod(op);
  if (!method) {
    return textResult(
      `model 没有这个 op「${op}」。不提供 set_default、use 或 summarizer；这个 area 只配置服务商和模型目录。先用 area=guide + topic=model 看教程。`,
      { area: "model", error: "bad_op", op },
      true,
    );
  }
  const callParams: Record<string, unknown> = {};
  if (params.provider !== undefined) callParams.provider = params.provider;
  if (params.providerId?.trim()) callParams.providerId = params.providerId.trim();
  if (params.request !== undefined) callParams.request = params.request;
  if (params.modelIds !== undefined) callParams.modelIds = params.modelIds;
  if (params.refresh !== undefined) callParams.refresh = params.refresh;
  if (params.flowId?.trim()) callParams.flowId = params.flowId.trim();
  if (params.promptId?.trim()) callParams.promptId = params.promptId.trim();
  if (params.value !== undefined) callParams.value = params.value;
  if (params.revision !== undefined) callParams.revision = params.revision;
  if (params.timeoutMs !== undefined) callParams.timeoutMs = params.timeoutMs;
  if (params.ws !== undefined) callParams.ws = params.ws;
  if (method === "model_set_enabled" && params.enabled !== undefined) callParams.enabled = params.enabled;
  if (method === "model_set_enabled" && params.enabled === undefined) callParams.enabled = !isDisableOp(op);
  try {
    const data = await setupRpc(pi, method, callParams, ctx.cwd || undefined);
    if (method === "model_list") {
      const configuration = isRecord(data) ? data.configuration : undefined;
      return textResult(renderModelConfiguration(configuration), { area: "model", op, method, configuration: configuration ?? null });
    }
    if (method === "model_fetch_models") {
      return textResult(renderModelFetch(data), { area: "model", op, method, ...(isRecord(data) ? data : {}) });
    }
    if (method === "model_catalog") {
      return textResult(renderModelCatalog(data), { area: "model", op, method, ...(isRecord(data) ? data : {}) });
    }
    if (method === "model_test") {
      const result = isRecord(data) && isRecord(data.result) ? data.result : {};
      const ok = result.ok === true;
      const message = typeof result.message === "string" ? result.message : "没有测试结果。";
      const detail = typeof result.detail === "string" ? `\n${result.detail}` : "";
      return textResult(`${ok ? "连接测试成功" : "连接测试失败"}：${message}${detail}`, { area: "model", op, method, ...(isRecord(data) ? data : {}) }, !ok);
    }
    if (method === "model_auth_start" || method === "model_auth_status" || method === "model_auth_await" || method === "model_auth_respond") {
      return textResult(renderModelAuth(data), { area: "model", op, method, ...(isRecord(data) ? data : {}) });
    }
    if (method === "model_auth_cancel") {
      return textResult("订阅登录已取消。", { area: "model", op, method, ...(isRecord(data) ? data : {}) });
    }
    if (method === "model_ws_get") {
      return textResult(`OpenAI Responses WS 配置：\n${JSON.stringify(isRecord(data) ? data.configuration : data, null, 2) ?? "{}"}`, { area: "model", op, method, ...(isRecord(data) ? data : {}) });
    }
    if (method === "model_ws_save") {
      return textResult(`OpenAI Responses WS 已保存并 reload。\n${JSON.stringify(isRecord(data) ? data.ws : data, null, 2) ?? "{}"}`, { area: "model", op, method, ...(isRecord(data) ? data : {}) });
    }
    return textResult(renderModelResult(data, method === "model_logout" ? "退出登录" : op), { area: "model", op, method, ...(isRecord(data) ? data : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(message, { area: "model", op, method, error: "rpc_failed", message }, true);
  }
}

async function executeGuide(params: CoilcoilParamsValue): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError: boolean }> {
  const op = (params.op ?? "mcp").trim().toLowerCase();
  if (op === "read_doc") {
    const doc = params.doc?.trim() || params.topic?.trim() || "readme";
    try {
      const found = readBundledDoc(workflowDir(), doc);
      const preview = summarizeBundledDoc(found.path, found.content, DOC_PREVIEW_CHARS);
      return textResult(preview.content, {
        area: "guide",
        op: "read_doc",
        doc,
        path: preview.path,
        truncated: preview.truncated,
        totalChars: preview.totalChars,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult(message, { area: "guide", op: "read_doc", doc, error: "doc_not_found" }, true);
    }
  }
  const topic = (params.topic ?? op) as GuideTopic;
  if (topic !== "skill" && topic !== "mcp" && topic !== "auth" && topic !== "model") {
    return textResult(
      `topic 只能是 skill / mcp / auth / model；要读自带文档用 op=read_doc + doc=文档名。`,
      { area: "guide", error: "bad_topic", topic: params.topic ?? params.op },
      true,
    );
  }
  const agentDir = (() => {
    try {
      return getAgentDir();
    } catch {
      return process.env.PI_CODING_AGENT_DIR?.trim() || "(拿不到 agent 目录)";
    }
  })();
  return textResult(setupGuide(topic, agentDir), { area: "guide", topic });
}

async function executeMcp(
  pi: ExtensionAPI,
  params: CoilcoilParamsValue,
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError: boolean }> {
  const op = (params.op ?? "list").trim();
  const method = resolveMcpMethod(op);
  if (!method) {
    return textResult(
      `mcp 没有这个 op「${op}」。先用 area=guide + topic=mcp 看看该怎么配。`,
      { area: "mcp", error: "bad_op", op },
      true,
    );
  }
  const cwd = ctx.cwd || undefined;
  const callParams: Record<string, unknown> = {};
  if (params.name?.trim()) callParams.name = params.name.trim();
  if (params.server !== undefined) callParams.server = params.server;
  if (params.text !== undefined) callParams.text = params.text;
  if (params.input !== undefined) callParams.input = params.input;
  if (params.enabled !== undefined) callParams.enabled = params.enabled;
  if (params.scope?.trim()) callParams.scope = params.scope.trim();
  if (params.previousName?.trim()) callParams.previousName = params.previousName.trim();
  if (params.servers !== undefined) callParams.servers = params.servers;
  if (params.imports !== undefined) callParams.imports = params.imports;
  // The document arrives as `text` — the one field the schema offers for free
  // text — and the runtime asks for `content`. The names disagreed and nobody
  // could save a mcp.json at all, because `content` was not even in the schema
  // to be sent. One mapping, here, rather than two spellings in the schema.
  if (method === "mcp_save_json") {
    const document = params.text ?? params.input;
    if (typeof document === "string") callParams.content = document;
  }
  // `disable` / `session_disable` spell false without making the model say it.
  if ((method === "mcp_set_enabled" || method === "mcp_set_session_enabled") && params.enabled === undefined) {
    callParams.enabled = !isDisableOp(op);
  }
  if (method === "mcp_auth_complete" && callParams.input === undefined && typeof callParams.text === "string") {
    callParams.input = callParams.text;
  }
  try {
    const data = await setupRpc(pi, method, callParams, cwd);
    if (!isRecord(data)) return textResult("运行时回了个看不懂的应答。", { area: "mcp", op, method }, true);
    if (method === "mcp_list") {
      const configuration = (data as { configuration?: unknown }).configuration;
      return textResult(renderMcpConfiguration(configuration), { area: "mcp", op, method, configuration });
    }
    if (method === "mcp_get_json") {
      const document = (data as { document?: { path?: string; content?: string } }).document;
      return textResult(
        typeof document?.content === "string" ? document.content : "没能读到 mcp.json。",
        { area: "mcp", op, method, path: document?.path, document },
      );
    }
    if (method === "mcp_parse_snippet") {
      const snippets = (data as { snippets?: unknown }).snippets;
      return textResult(renderSnippets(snippets), { area: "mcp", op, method, snippets });
    }
    if (method === "mcp_save_server" || method === "mcp_save_json" || method === "mcp_remove"
      || method === "mcp_set_enabled" || method === "mcp_import" || method === "mcp_enable_imports") {
      const configuration = (data as { configuration?: unknown }).configuration;
      const done = method === "mcp_remove"
        ? "已移除并 reload。配置来自别的工具时只是在 CoilCoil 里隐起来，源文件不动；重新 save 同名即可恢复。"
        : method === "mcp_set_enabled"
          ? `已${callParams.enabled === false ? "停用" : "启用"}并 reload，Agent 侧已生效。`
          : "已保存并 reload，Agent 侧已生效。";
      return textResult(
        `${renderMcpConfiguration(configuration)}\n\n${done}`,
        { area: "mcp", op, method, configuration },
      );
    }
    if (method === "mcp_set_session_enabled") {
      return textResult(sessionMcpText(callParams.enabled !== false, callParams.name, data), {
        area: "mcp",
        op,
        method,
        name: callParams.name,
        enabled: callParams.enabled !== false,
      });
    }
    if (method === "mcp_discover") {
      const discovery = (data as { discovery?: { servers?: Array<{ origin?: string; name?: string; alreadyPresent?: boolean }> } }).discovery;
      const servers = discovery?.servers ?? [];
      const text = servers.length
        ? ["在别的工具里发现这些，还没搬过来（同名的不会覆盖）：",
          ...servers.map((entry) => `- ${entry.origin ?? "?"} · ${entry.name ?? "?"}${entry.alreadyPresent ? "（已在 CoilCoil 里有同名）" : ""}`),
        ].join("\n")
        : "别的工具里没发现可搬的 MCP 服务器。";
      return textResult(text, { area: "mcp", op, method, discovery });
    }
    const result = (data as { result?: { text?: string; details?: unknown } }).result;
    const text = typeof result?.text === "string"
      ? result.text
      // 一句「做完了但没说什么」请谁都判断不了成败。没话就是有问题，直说。
      : `${op} 没有得到运行时的回应，请当成没做成，用 op=list 或 op=connect 核对当前状态。`;
    const details = isRecord(result?.details) ? result.details as Record<string, unknown> : {};
    if (method === "mcp_connect") {
      const error = typeof details.error === "string" ? details.error : undefined;
      const hint = error === "auth_required"
        ? "\n\n这不是失败：去走 topic=auth 那四步（op=auth_start 先拿链接给用户点）。"
        : "";
      return textResult(`${text}${hint}`, { area: "mcp", op, method, ...details }, error !== undefined && error !== "auth_required");
    }
    if (method === "mcp_auth_start") {
      const url = typeof details.authorizationUrl === "string" ? details.authorizationUrl : undefined;
      const hint = url ? `\n\n把这个链接给用户去浏览器里点：${url}` : "";
      return textResult(`${text}${hint}`, { area: "mcp", op, method, ...details });
    }
    return textResult(text, { area: "mcp", op, method, ...details });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(message, { area: "mcp", op, method, error: "rpc_failed", message }, true);
  }
}

async function executeSkill(
  pi: ExtensionAPI,
  params: CoilcoilParamsValue,
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError: boolean }> {
  const op = (params.op ?? "list").trim();
  const method = resolveSkillMethod(op);
  if (!method) {
    return textResult(
      `skill 没有这个 op「${op}」。先用 area=guide + topic=skill 看看该装到哪。`,
      { area: "skill", error: "bad_op", op },
      true,
    );
  }
  const cwd = ctx.cwd || undefined;
  const callParams: Record<string, unknown> = {};
  if (params.filePath?.trim()) callParams.filePath = params.filePath.trim();
  if (params.path?.trim()) callParams.path = params.path.trim();
  if (params.enabled !== undefined) callParams.enabled = params.enabled;
  if (method === "skill_set_enabled" || method === "skill_set_session_enabled") {
    if (params.enabled === undefined) callParams.enabled = !isDisableOp(op);
  }
  try {
    const data = await setupRpc(pi, method, callParams, cwd);
    if (!isRecord(data)) return textResult("运行时回了个看不懂的应答。", { area: "skill", op, method }, true);
    if (method === "skill_set_session_enabled") {
      const enabled = callParams.enabled !== false;
      return textResult(
        enabled ? "这个 Skill 在当前会话恢复启用（配置没动）。" : "这个 Skill 在当前会话已停用（配置没动，切个会话就回来）。",
        { area: "skill", op, method },
      );
    }
    const configuration = (data as { configuration?: unknown }).configuration;
    return textResult(
      `${renderSkillConfiguration(configuration)}${skillDoneText(method, callParams.enabled !== false)}`,
      { area: "skill", op, method, configuration },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return textResult(message, { area: "skill", op, method, error: "rpc_failed", message }, true);
  }
}

export default function coilcoilSetupTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: COILCOIL_TOOL_NAME,
    label: "CoilCoil",
    description: [
      "CoilCoil's own manual and configuration entry: area=guide serves the tutorials first (Skill / MCP / model providers); area=mcp inspects, edits and connects MCP servers (including browser authentication); area=skill lists, installs, enables and disables Skills; area=model configures providers, model capabilities, upstream metadata, connectivity and subscription OAuth.",
      "Never edit these configuration files yourself with bash or any other tool. When the user asks you to set up MCP, install a Skill, configure a model provider, fill in model capabilities or sign in to a subscription, read the matching tutorial with area=guide first, then act.",
      "Read bundled documents (architecture, requirements, roadmap) by name with area=guide + op=read_doc instead of scanning the directory.",
      "The model area only configures providers and the model catalog; it has no set_default, use, session model or summarizer, so do not try to change the current model selection through it.",
      "An mcp op=connect that reports needs-auth is not a failure: go through the four steps auth_start, hand the link to the user to click, auth_await_each, auth_finish. For subscription models use model op=auth_start, give the user the authUrl, then op=auth_await / auth_respond; this is the same runtime OAuth as MCP. Never curl an authorization address yourself.",
    ].join(" "),
    parameters: CoilcoilParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const value = params as CoilcoilParamsValue;
      if (value.area === "guide") return executeGuide(value);
      if (value.area === "mcp") return executeMcp(pi, value, ctx);
      if (value.area === "model") return executeModel(pi, value, ctx);
      return executeSkill(pi, value, ctx);
    },
  });
}
