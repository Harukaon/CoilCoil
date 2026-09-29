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
  id: Type.String({ description: "模型 ID，会原样发送给服务商" }),
  name: Type.Optional(Type.String({ description: "显示名称" })),
  api: Type.Optional(Type.String({ description: "该模型覆盖使用的请求协议" })),
  baseUrl: Type.Optional(Type.String({ description: "该模型覆盖使用的 Base URL" })),
  reasoning: Type.Optional(Type.Boolean({ description: "是否支持 Thinking / 推理" })),
  thinkingLevelMap: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]), { description: "Thinking 级别到上游 effort 的映射；null 表示不支持" })),
  input: Type.Optional(Type.Array(StringEnum(["text", "image"]), { description: "输入模态；要支持图片必须包含 image" })),
  contextWindow: Type.Optional(Type.Number({ description: "最大上下文窗口 Token 数" })),
  maxTokens: Type.Optional(Type.Number({ description: "最大输出 Token 数" })),
  cost: Type.Optional(ModelCostParams),
  samplingParams: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "temperature、top_p 等采样参数" })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "模型专用请求头；已存在的敏感值用 •••••• 原样传回表示不改" })),
  compat: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Pi provider 兼容性参数" })),
}, { additionalProperties: false });

const ModelCredentialParams = Type.Object({
  method: Type.String({ description: "credential.methods 中的方式 ID" }),
  values: Type.Record(Type.String(), Type.String(), { description: "凭据字段；按用户要求填写" }),
  preserveFields: Type.Optional(Type.Array(Type.String(), { description: "留空但仍保留的已配置凭据字段" })),
});

const ModelProviderParams = Type.Object({
  id: Type.String({ description: "服务商 ID，只能是字母、数字、点、短横线、下划线" }),
  name: Type.Optional(Type.String({ description: "服务商显示名称" })),
  baseUrl: Type.Optional(Type.String({ description: "服务商 Base URL" })),
  api: Type.Optional(Type.String({ description: "请求协议 ID；先从 model op=list 的 supportedApis 中选择" })),
  oauth: Type.Optional(StringEnum(["radius"], { description: "订阅 OAuth 服务商类型" })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "服务商请求头；敏感值可用 •••••• 原样保留" })),
  compat: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "服务商兼容性 JSON" })),
  authHeader: Type.Optional(Type.Boolean({ description: "是否由 Pi 自动写入 Authorization 请求头" })),
  apiKeyReference: Type.Optional(Type.String({ description: "可选的 API Key 来源；传空字符串可清除" })),
  preserveApiKeyReference: Type.Optional(Type.Boolean({ description: "未提供新引用时是否保留 models.json 中已有的密钥引用" })),
  disabled: Type.Optional(Type.Boolean({ description: "保留配置但从模型列表隐藏" })),
  replaceModels: Type.Optional(Type.Boolean({ description: "是否用 models 替换 Pi 内置模型目录" })),
  models: Type.Optional(Type.Array(ModelDefinitionParams, { description: "服务商模型目录；默认按 id 增量合并" })),
  modelsMode: Type.Optional(StringEnum(["merge", "replace"], { description: "models 的处理方式，默认 merge" })),
  removeModels: Type.Optional(Type.Array(Type.String(), { description: "按模型 ID 移除现有模型" })),
  modelOverrides: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "按模型 ID 的运行时覆盖" })),
  apiKey: Type.Optional(Type.String({ description: "API Key；按用户要求用于服务商配置" })),
  credential: Type.Optional(ModelCredentialParams),
}, { additionalProperties: false, description: "model op=save 的服务商增量配置；未提供的字段保持不变" });

const ModelRequestParams = Type.Object({
  baseUrl: Type.Optional(Type.String()),
  api: Type.Optional(Type.String()),
  apiKey: Type.Optional(Type.String({ description: "API Key；按用户要求用于本次拉取或测试" })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  provider: Type.Optional(Type.String({ description: "已有服务商 ID；省略 apiKey 时使用该服务商已配置的凭据" })),
  modelId: Type.Optional(Type.String({ description: "测试连接时使用的模型 ID" })),
});

const WsConfigurationParams = Type.Object({
  baseUrl: Type.String({ description: "OpenAI Responses WS 地址" }),
  apiKey: Type.Optional(Type.String({ description: "API Key；按用户要求用于 WS 配置" })),
  preserveApiKey: Type.Optional(Type.Boolean()),
  fast: Type.Optional(Type.Boolean()),
});

export const CoilcoilParams = Type.Object({
  area: StringEnum(["guide", "mcp", "skill", "model"], {
    description: "guide：先看教程；mcp：查配改连 MCP；skill：列装启停 Skill；model：配置模型服务商、模型能力、元数据和订阅登录",
  }),
  op: Type.Optional(Type.String({
    description: "guide: skill / mcp / auth / model / read_doc；mcp: list/save/get_json/save_json/remove/enable/disable/discover/import/parse_snippet/connect/auth_start/auth_await_each/auth_finish/auth_cancel/auth_complete/logout/session_enable/session_disable；skill: list/install/enable/disable/remove/delete/session_enable/session_disable；model: list/save/remove/enable/disable/fetch_models/catalog/test/auth_start/auth_status/auth_await/auth_respond/auth_cancel/logout/ws_get/ws_save",
  })),
  topic: Type.Optional(Type.String({ description: "area=guide 且 op 不为 read_doc 时：skill / mcp / auth / model" })),
  providerId: Type.Optional(Type.String({ description: "model 服务商 ID；也可用 name 兼容填写" })),
  provider: Type.Optional(ModelProviderParams),
  request: Type.Optional(ModelRequestParams),
  modelIds: Type.Optional(Type.Array(Type.String(), { description: "model op=catalog 的模型 ID 数组" })),
  refresh: Type.Optional(Type.Boolean({ description: "model op=catalog 是否忽略 24 小时缓存重新抓取" })),
  flowId: Type.Optional(Type.String({ description: "model OAuth flow ID" })),
  promptId: Type.Optional(Type.String({ description: "model OAuth 当前交互提示 ID" })),
  value: Type.Optional(Type.String({ description: "model OAuth 对当前提示的回答" })),
  revision: Type.Optional(Type.Number({ description: "model op=auth_await 上一次收到的 revision" })),
  timeoutMs: Type.Optional(Type.Number({ description: "model op=auth_await 最长等待毫秒数" })),
  ws: Type.Optional(WsConfigurationParams),
  doc: Type.Optional(Type.String({ description: "area=guide + op=read_doc 时：文档名，如 architecture、readme" })),
  name: Type.Optional(Type.String({ description: "mcp 的 Server 名（connect/认证/logout/enable/remove 用）" })),
  filePath: Type.Optional(Type.String({ description: "skill 的文件路径（enable/disable/remove/delete 用）" })),
  path: Type.Optional(Type.String({ description: "skill 的本地目录（install 用）" })),
  // 字段必须逐个写出来。之前这里是 Type.Any，它序列化成一个空 schema `{}`，
  // 模型看不出要填什么、provider 那边也容易直接把这个参数丢掉——结果就是 save
  // 永远收到「缺少 server」，唯一合规的配置通道是坏的。
  server: Type.Optional(Type.Object({
    name: Type.Optional(Type.String({ description: "Server 名，只能是字母、数字、点、下划线、连字符" })),
    scope: Type.Optional(StringEnum(["global", "project"], { description: "默认 global；project 只给当前工作区用" })),
    transport: Type.Optional(StringEnum(["stdio", "http"], { description: "stdio 要 command；http 要 url" })),
    command: Type.Optional(Type.String({ description: "stdio 的启动命令，如 npx" })),
    args: Type.Optional(Type.Array(Type.String(), { description: "stdio 的命令参数" })),
    env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "stdio 的环境变量；敏感值用 ${VAR} 占位符" })),
    cwd: Type.Optional(Type.String({ description: "stdio 的工作目录" })),
    url: Type.Optional(Type.String({ description: "http 的服务器地址" })),
    headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "http 的请求头；敏感值用 ${VAR} 占位符" })),
    auth: Type.Optional(Type.Union([StringEnum(["oauth", "bearer"]), Type.Literal(false)], { description: "oauth 走浏览器认证；false 是明确不认证" })),
    bearerTokenEnv: Type.Optional(Type.String({ description: "放令牌的环境变量名；如果直接填写令牌，提醒用户已暴露并建议轮换" })),
    lifecycle: Type.Optional(StringEnum(["lazy", "eager", "keep-alive"], { description: "默认 lazy：用到才连、闲置放手" })),
    idleTimeout: Type.Optional(Type.Number({ description: "闲置多少分钟后断开" })),
    requestTimeoutMs: Type.Optional(Type.Number({ description: "单次调用超时（毫秒）" })),
    exposeResources: Type.Optional(Type.Boolean({ description: "是否把该 Server 的 resources 暴露给 Agent" })),
    directTools: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())], { description: "true 或工具名列表：把这几个工具直接注册给模型（每轮都占 token，慎用）" })),
    excludeTools: Type.Optional(Type.Array(Type.String(), { description: "不暴露的工具名" })),
    debug: Type.Optional(Type.Boolean({ description: "打开该 Server 的调试日志" })),
    disabled: Type.Optional(Type.Boolean({ description: "保存后直接停用" })),
  }, {
    additionalProperties: true,
    description: "mcp save 的服务器定义；stdio 至少给 name+command，http 至少给 name+url",
  })),
  text: Type.Optional(Type.String({ description: "parse_snippet 的配置 JSON；save_json 的 mcp.json 全文；auth_complete 粘贴的回调内容" })),
  input: Type.Optional(Type.String({ description: "auth_complete 粘贴的回调内容的别名，和 text 二选一" })),
  enabled: Type.Optional(Type.Boolean({ description: "enable/disable/session_enable/session_disable 的开关；省略时按 op 名字推断" })),
  scope: Type.Optional(StringEnum(["global", "project"], { description: "save/remove 的作用域，默认 global" })),
  previousName: Type.Optional(Type.String({ description: "改名保存时填旧名" })),
  servers: Type.Optional(Type.Array(Type.Object({
    origin: Type.String({ description: "来源工具：cursor / claude-code / claude-desktop / codex / opencode / windsurf / vscode" }),
    name: Type.String({ description: "该来源里的 Server 名" }),
  }), { description: "import 时要搬过来的服务器，来自 discover 的结果" })),
  imports: Type.Optional(Type.Array(Type.String(), { description: "enable_imports 要启用的来源列表" })),
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
    description:
      "CoilCoil 自己的说明书和配置口：guide 先看教程（Skill / MCP / 模型服务商），mcp 查配改连 MCP（含浏览器认证），skill 列装启停 Skill，model 配服务商、模型能力、上游元数据、连通性和订阅 OAuth。不要自己 bash 改这些配置文件。",
    promptSnippet: "coilcoil: CoilCoil 自己的配置（MCP/Skill/模型服务商）和自带文档",
    promptGuidelines: [
      "用户让你配 MCP、装 Skill、配模型服务商、补模型能力或登录订阅时，先用 area=guide 看对应教程，再动手；不要上来就 bash 改配置文件。",
      "模型 area 只配置服务商和模型目录，不提供 set_default、use、session model 或 summarizer，不要尝试用它改变当前模型选择。",
      "自带文档（架构、需求、路线图）用 area=guide + op=read_doc 按名读，不要整目录扫。",
      "mcp op=connect 报 needs-auth 不是失败，是去走 auth_start → 拿链接给用户点 → auth_await_each → auth_finish 那四步；Agent 永远不要自己 curl 授权地址。",
      "订阅模型用 model op=auth_start → 把 authUrl 给用户 → op=auth_await / auth_respond，和 MCP 一样走运行时 OAuth，不要自己 curl 授权地址。",
    ],
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
