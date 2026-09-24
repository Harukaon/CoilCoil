import type {
  FetchProviderModelsInput,
  FetchProviderModelsResult,
  ImportMcpServersInput,
  McpConfigurationSnapshot,
  McpDiscoveryResult,
  McpImportConfiguration,
  McpJsonDocument,
  McpServerConfiguration,
  ModelProviderAuthSnapshot,
  ModelProviderAuthState,
  ModelProviderConfigurationSnapshot,
  ModelProviderPatchInput,
  ModelProviderSaveResult,
  OpenAIResponsesWsConfiguration,
  OpenAIResponsesWsConfigurationInput,
  RuntimeConfiguration,
  TestProviderConnectionInput,
  TestProviderConnectionResult,
} from "@coilcoil/runtime-protocol";
import {
  SETUP_RPC_REPLY_PREFIX,
  SETUP_RPC_REQUEST_CHANNEL,
} from "./runtime-constants.js";
import {
  errorMessage,
  isRecord,
  sensitiveConfigurationKey,
  stringValue,
} from "./runtime-utils.js";
import {
  MASKED_SECRET_VALUE,
  maskMcpJsonText,
  maskSecretMap,
  maskSecretUrl,
  restoreMcpJsonText,
  restoreSecretMap,
  restoreSecretUrl,
} from "./setup-secrets.js";
import {
  redactSensitiveText,
} from "./session-values.js";
import type {
  EventBusController,
} from "@earendil-works/pi-coding-agent";
import type { ModelCatalogLookupResult } from "@coilcoil/runtime-protocol/model-catalog";

/**
 * The runtime half of the `coilcoil` setup tool.
 *
 * The extension side only knows `emit`/`on`; it never sees this object. Every
 * answer goes through the same methods the settings panel calls, so a server
 * the agent saves is saved exactly the way the panel saves it: same file,
 * same validation, same live-session reload, same connect check.
 *
 * A mixin, not a layer in the class chain: it only ever calls methods that
 * already exist further down (RuntimeMcpConfig / RuntimeResourcesController),
 * so there is no new abstract surface and no hierarchy to rewire.
 */
export interface SetupRpcRequest {
  version: 1;
  requestId: string;
  /** Same vocabulary as the tool's `op`, minus the local-only `guide` / `read_doc`. */
  method:
    | "mcp_list"
    | "mcp_get_json"
    | "mcp_save_json"
    | "mcp_save_server"
    | "mcp_remove"
    | "mcp_set_enabled"
    | "mcp_discover"
    | "mcp_import"
    | "mcp_enable_imports"
    | "mcp_parse_snippet"
    | "mcp_connect"
    | "mcp_auth_start"
    | "mcp_auth_await_callback"
    | "mcp_auth_finish"
    | "mcp_auth_await"
    | "mcp_auth_cancel"
    | "mcp_auth_complete"
    | "mcp_logout"
    | "mcp_set_session_enabled"
    | "model_list"
    | "model_save"
    | "model_remove"
    | "model_set_enabled"
    | "model_fetch_models"
    | "model_catalog"
    | "model_test"
    | "model_auth_start"
    | "model_auth_status"
    | "model_auth_await"
    | "model_auth_respond"
    | "model_auth_cancel"
    | "model_logout"
    | "model_ws_get"
    | "model_ws_save"
    | "skill_list"
    | "skill_set_enabled"
    | "skill_remove"
    | "skill_delete"
    | "skill_install"
    | "skill_remove_path"
    | "skill_set_session_enabled";
  params?: Record<string, unknown>;
  cwd?: string;
}

export interface SetupRpcHost {
  getMcpConfiguration(cwd?: string): Promise<McpConfigurationSnapshot>;
  getMcpJson(): Promise<McpJsonDocument>;
  saveMcpJson(content: string, cwd?: string): Promise<McpConfigurationSnapshot>;
  saveMcpServer(server: McpServerConfiguration, previousName?: string, cwd?: string): Promise<McpConfigurationSnapshot>;
  removeMcpServer(name: string, scope?: "global" | "project", cwd?: string): Promise<McpConfigurationSnapshot>;
  setMcpServerEnabled(name: string, enabled: boolean, cwd: string): Promise<McpConfigurationSnapshot>;
  discoverMcpServers(cwd?: string): Promise<McpDiscoveryResult>;
  importMcpServers(input: ImportMcpServersInput): Promise<McpConfigurationSnapshot>;
  enableMcpImports(imports: McpImportConfiguration["kind"][], cwd?: string): Promise<McpConfigurationSnapshot>;
  connectMcpServer(name: string): Promise<{ text: string; details?: Record<string, unknown>; status?: unknown }>;
  startMcpAuth(name: string): Promise<{ text: string; details?: Record<string, unknown>; status?: unknown }>;
  awaitMcpAuthCallback(name: string): Promise<{ text: string; details?: Record<string, unknown>; status?: unknown }>;
  finishMcpAuth(name: string): Promise<{ text: string; details?: Record<string, unknown>; status?: unknown }>;
  awaitMcpAuth(name: string): Promise<{ text: string; details?: Record<string, unknown>; status?: unknown }>;
  cancelMcpAuth(name: string): Promise<{ text: string; details?: Record<string, unknown>; status?: unknown }>;
  completeMcpAuth(name: string, input: string): Promise<{ text: string; details?: Record<string, unknown>; status?: unknown }>;
  logoutMcpServer(name: string): Promise<{ text: string; details?: Record<string, unknown>; status?: unknown }>;
  setSessionMcpServerEnabled(name: string, enabled: boolean): Promise<unknown>;
  getModelProviderConfiguration(): Promise<ModelProviderConfigurationSnapshot>;
  saveModelProviderPatch(input: ModelProviderPatchInput): Promise<ModelProviderSaveResult>;
  removeModelProviderConfiguration(providerId: string): Promise<RuntimeConfiguration>;
  setModelProviderEnabled(providerId: string, enabled: boolean): Promise<ModelProviderSaveResult>;
  fetchProviderModels(input: FetchProviderModelsInput): Promise<FetchProviderModelsResult>;
  getModelCatalogMetadata(modelIds: readonly string[], refresh?: boolean): Promise<ModelCatalogLookupResult>;
  testProviderConnection(input: TestProviderConnectionInput): Promise<TestProviderConnectionResult>;
  startModelProviderOAuth(providerId: string): Promise<ModelProviderAuthState>;
  getModelProviderOAuth(flowId: string): Promise<ModelProviderAuthSnapshot>;
  awaitModelProviderOAuth(flowId: string, afterRevision?: number, timeoutMs?: number): Promise<ModelProviderAuthSnapshot>;
  respondModelProviderOAuth(flowId: string, promptId: string, value: string): Promise<void>;
  cancelModelProviderOAuth(flowId: string): Promise<void>;
  removeProviderAuth(provider: string): Promise<RuntimeConfiguration>;
  getOpenAIResponsesWsConfiguration(): Promise<OpenAIResponsesWsConfiguration>;
  saveOpenAIResponsesWsConfiguration(input: OpenAIResponsesWsConfigurationInput): Promise<RuntimeConfiguration>;
  getSkillConfiguration(cwd?: string): Promise<unknown>;
  setSkillEnabled(filePath: string, enabled: boolean, cwd?: string): Promise<unknown>;
  removeSkill(filePath: string, cwd?: string): Promise<unknown>;
  deleteSkill(filePath: string, cwd?: string): Promise<unknown>;
  addSkillPath(path: string, cwd?: string): Promise<unknown>;
  removeSkillPath(path: string, cwd?: string): Promise<unknown>;
  setSessionSkillEnabled(filePath: string, enabled: boolean): Promise<unknown>;
}

export function setupRpcReplyChannel(requestId: string): string {
  return `${SETUP_RPC_REPLY_PREFIX}${requestId}`;
}

function setupRequestFrom(raw: unknown): SetupRpcRequest | undefined {
  if (!isRecord(raw) || raw.version !== 1) return undefined;
  if (typeof raw.requestId !== "string" || !raw.requestId.trim()) return undefined;
  if (typeof raw.method !== "string" || !raw.method.trim()) return undefined;
  return {
    version: 1,
    requestId: raw.requestId.trim(),
    method: raw.method.trim() as SetupRpcRequest["method"],
    params: isRecord(raw.params) ? raw.params : undefined,
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
  };
}

/** Secrets never reach the model: the whole point of handing it structured results. */
function maskServerForAgent(server: McpServerConfiguration): McpServerConfiguration {
  return {
    ...server,
    env: maskSecretMap(server.env),
    headers: maskSecretMap(server.headers),
    url: maskSecretUrl(server.url),
  };
}

function maskMcpSnapshot(snapshot: McpConfigurationSnapshot): McpConfigurationSnapshot {
  return { ...snapshot, servers: snapshot.servers.map(maskServerForAgent) };
}

/** `••••••` means "unchanged": resolve it against what is on disk before saving. */
async function unmaskServerForSave(
  host: SetupRpcHost,
  server: McpServerConfiguration,
  previousName: string | undefined,
  cwd?: string,
): Promise<McpServerConfiguration> {
  const needsResolve = Object.values(server.env).includes(MASKED_SECRET_VALUE)
    || Object.values(server.headers).includes(MASKED_SECRET_VALUE)
    || server.url?.includes(MASKED_SECRET_VALUE);
  if (!needsResolve) return server;
  const current = (await host.getMcpConfiguration(cwd)).servers.find((entry) => entry.name === (previousName ?? server.name));
  if (!current) return server;
  return {
    ...server,
    env: restoreSecretMap(server.env, current.env),
    headers: restoreSecretMap(server.headers, current.headers),
    url: restoreSecretUrl(server.url, current.url),
  };
}

function stringParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key];
  return typeof value === "string" ? value : undefined;
}

function stringArrayParam(params: Record<string, unknown> | undefined, key: string): string[] | undefined {
  const value = params?.[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) return undefined;
  return [...value];
}

function serverFromParams(params: Record<string, unknown> | undefined): McpServerConfiguration {
  if (!isRecord(params?.server)) throw new Error("缺少 server（要保存的 MCP 服务器定义）。");
  const raw = params.server;
  const stringRecord = (value: unknown): Record<string, string> => {
    if (!isRecord(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  };
  const stringList = (value: unknown): string[] => (
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
  );
  const transport = raw.transport === "http" ? "http" : "stdio";
  const scope = raw.scope === "project" ? "project" : "global";
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    scope,
    transport,
    command: typeof raw.command === "string" ? raw.command : undefined,
    args: stringList(raw.args),
    env: stringRecord(raw.env),
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    url: typeof raw.url === "string" ? raw.url : undefined,
    headers: stringRecord(raw.headers),
    auth: raw.auth === "oauth" || raw.auth === "bearer" || raw.auth === false ? raw.auth : undefined,
    bearerTokenEnv: typeof raw.bearerTokenEnv === "string" ? raw.bearerTokenEnv : undefined,
    lifecycle: raw.lifecycle === "keep-alive" || raw.lifecycle === "eager" ? raw.lifecycle : "lazy",
    idleTimeout: typeof raw.idleTimeout === "number" ? raw.idleTimeout : undefined,
    requestTimeoutMs: typeof raw.requestTimeoutMs === "number" ? raw.requestTimeoutMs : undefined,
    exposeResources: raw.exposeResources !== false,
    directTools: raw.directTools === true ? true : stringList(raw.directTools),
    excludeTools: stringList(raw.excludeTools),
    debug: raw.debug === true,
    disabled: raw.disabled === true,
  };
}

function setupParamSensitiveValues(value: unknown, key = "", output: string[] = []): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const secretKey = sensitiveConfigurationKey(key) || /^(headers|credential|ws)$/i.test(key);
    if (secretKey && trimmed && trimmed !== MASKED_SECRET_VALUE && !trimmed.startsWith("$") && !trimmed.startsWith("!")) output.push(trimmed);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) setupParamSensitiveValues(item, key, output);
    return output;
  }
  if (isRecord(value)) {
    for (const [childKey, childValue] of Object.entries(value)) setupParamSensitiveValues(childValue, childKey, output);
  }
  return output;
}

async function hostSensitiveValues(host: SetupRpcHost, cwd?: string, params?: Record<string, unknown>): Promise<string[]> {
  try {
    const configuration = await host.getMcpConfiguration(cwd);
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
          for (const [key, value] of parsed.searchParams) {
            if (sensitiveConfigurationKey(key) && value) secrets.push(value);
          }
        } catch {
          // Malformed URLs have no safe structured secrets to inspect.
        }
      }
    }
    return [...new Set([...secrets, ...setupParamSensitiveValues(params)])];
  } catch {
    return setupParamSensitiveValues(params);
  }
}

/**
 * Answer the `coilcoil` tool's setup operations over the session event bus.
 *
 * Installed when the session is created so it is in place before any tool
 * call can ask. Session switches swap the whole bus, so a request that
 * arrives late answers for nobody — `requireActive` guards that.
 */
function providerIdParam(params: Record<string, unknown> | undefined): string | undefined {
  const provider = stringParam(params, "providerId") ?? stringParam(params, "provider");
  return provider?.trim() || stringParam(params, "name")?.trim() || undefined;
}

function requestRecord(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const request = params?.request;
  if (isRecord(request)) return request;
  const input = params?.input;
  if (isRecord(input)) return input;
  return params ?? {};
}

function stringMapParam(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length ? Object.fromEntries(entries) : {};
}

function providerFetchInput(params: Record<string, unknown> | undefined): FetchProviderModelsInput {
  const raw = requestRecord(params);
  const baseUrl = stringValue(raw.baseUrl).trim();
  if (!baseUrl) throw new Error("缺少 baseUrl（服务商 Base URL）。");
  return {
    baseUrl,
    api: stringValue(raw.api).trim() || undefined,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
    headers: stringMapParam(raw.headers),
    provider: typeof raw.provider === "string" ? raw.provider.trim() || undefined : providerIdParam(params),
  };
}

function providerTestInput(params: Record<string, unknown> | undefined): TestProviderConnectionInput {
  const raw = requestRecord(params);
  const input = providerFetchInput(params);
  const api = input.api?.trim();
  if (!api) throw new Error("缺少 api（请求协议）。");
  return {
    ...input,
    api,
    modelId: typeof raw.modelId === "string" ? raw.modelId : undefined,
  };
}

export function installSetupRpc(host: SetupRpcHost, eventBus: EventBusController, ensureActive: () => void): void {
  eventBus.on(SETUP_RPC_REQUEST_CHANNEL, async (raw: unknown) => {
    const request = setupRequestFrom(raw);
    if (!request) return;
    const replyChannel = setupRpcReplyChannel(request.requestId);
    const replyOk = (data: unknown): void => {
      eventBus.emit(replyChannel, { version: 1, requestId: request.requestId, success: true, data });
    };
    const replyError = (message: string): void => {
      eventBus.emit(replyChannel, { version: 1, requestId: request.requestId, success: false, error: { message } });
    };
    try {
      ensureActive();
    } catch {
      replyError("请先打开项目并创建会话。");
      return;
    }
    const cwd = request.cwd?.trim() || undefined;
    const params = request.params;
    try {
      switch (request.method) {
        case "mcp_list": {
          replyOk({ configuration: maskMcpSnapshot(await host.getMcpConfiguration(cwd)) });
          return;
        }
        case "mcp_get_json": {
          // The whole document, credentials masked — it lands in the transcript
          // and in the session file, and a key read once is a key leaked.
          const document = await host.getMcpJson();
          replyOk({ document: { ...document, content: maskMcpJsonText(document.content) } });
          return;
        }
        case "mcp_save_json": {
          // `text` is accepted as well: it is the field the tool schema offers
          // for free text, and a mismatch here once made saving impossible.
          const content = stringParam(params, "content") ?? stringParam(params, "text");
          if (typeof content !== "string") throw new Error("缺少 content（mcp.json 全文）。");
          const current = await host.getMcpJson();
          replyOk({
            configuration: maskMcpSnapshot(await host.saveMcpJson(restoreMcpJsonText(content, current.content), cwd)),
          });
          return;
        }
        case "mcp_save_server": {
          const server = await unmaskServerForSave(host, serverFromParams(params), stringParam(params, "previousName"), cwd);
          replyOk({
            configuration: maskMcpSnapshot(await host.saveMcpServer(server, stringParam(params, "previousName"), cwd)),
          });
          return;
        }
        case "mcp_remove": {
          const name = stringParam(params, "name")?.trim();
          if (!name) throw new Error("缺少 name（MCP Server 名称）。");
          const scope = params?.scope === "project" ? "project" : "global";
          replyOk({ configuration: maskMcpSnapshot(await host.removeMcpServer(name, scope, cwd)) });
          return;
        }
        case "mcp_set_enabled": {
          const name = stringParam(params, "name")?.trim();
          if (!name) throw new Error("缺少 name（MCP Server 名称）。");
          if (typeof params?.enabled !== "boolean") throw new Error("缺少 enabled（true/false）。");
          if (!cwd) throw new Error("启停 MCP 需要当前工作区。");
          replyOk({ configuration: maskMcpSnapshot(await host.setMcpServerEnabled(name, params.enabled, cwd)) });
          return;
        }
        case "mcp_discover": {
          replyOk({ discovery: await host.discoverMcpServers(cwd) });
          return;
        }
        case "mcp_import": {
          const servers = params?.servers;
          if (!Array.isArray(servers)) throw new Error("缺少 servers（要导入的 origin + name 列表）。");
          replyOk({
            configuration: maskMcpSnapshot(await host.importMcpServers({
              servers: servers as ImportMcpServersInput["servers"],
              cwd,
            })),
          });
          return;
        }
        case "mcp_enable_imports": {
          const imports = stringArrayParam(params, "imports");
          if (!imports) throw new Error("缺少 imports（要启用的来源列表）。");
          replyOk({
            configuration: maskMcpSnapshot(await host.enableMcpImports(
              imports as McpImportConfiguration["kind"][],
              cwd,
            )),
          });
          return;
        }
        case "mcp_parse_snippet": {
          const text = stringParam(params, "text");
          if (typeof text !== "string") throw new Error("缺少 text（要解析的 MCP 配置 JSON）。");
          const { parseMcpServerSnippets } = await import("@coilcoil/runtime-protocol");
          const parsed = parseMcpServerSnippets(text);
          if (!parsed.ok) throw new Error(parsed.error);
          replyOk({ snippets: parsed.servers });
          return;
        }
        case "mcp_connect": {
          const name = stringParam(params, "name")?.trim();
          if (!name) throw new Error("缺少 name（MCP Server 名称）。");
          replyOk({ result: await host.connectMcpServer(name) });
          return;
        }
        case "mcp_auth_start": {
          const name = stringParam(params, "name")?.trim();
          if (!name) throw new Error("缺少 name（MCP Server 名称）。");
          replyOk({ result: await host.startMcpAuth(name) });
          return;
        }
        case "mcp_auth_await_callback": {
          const name = stringParam(params, "name")?.trim();
          if (!name) throw new Error("缺少 name（MCP Server 名称）。");
          replyOk({ result: await host.awaitMcpAuthCallback(name) });
          return;
        }
        case "mcp_auth_finish": {
          const name = stringParam(params, "name")?.trim();
          if (!name) throw new Error("缺少 name（MCP Server 名称）。");
          replyOk({ result: await host.finishMcpAuth(name) });
          return;
        }
        case "mcp_auth_await": {
          const name = stringParam(params, "name")?.trim();
          if (!name) throw new Error("缺少 name（MCP Server 名称）。");
          replyOk({ result: await host.awaitMcpAuth(name) });
          return;
        }
        case "mcp_auth_cancel": {
          const name = stringParam(params, "name")?.trim();
          if (!name) throw new Error("缺少 name（MCP Server 名称）。");
          replyOk({ result: await host.cancelMcpAuth(name) });
          return;
        }
        case "mcp_auth_complete": {
          const name = stringParam(params, "name")?.trim();
          if (!name) throw new Error("缺少 name（MCP Server 名称）。");
          const input = stringParam(params, "input");
          if (typeof input !== "string") throw new Error("缺少 input（粘贴的回调内容）。");
          replyOk({ result: await host.completeMcpAuth(name, input) });
          return;
        }
        case "mcp_logout": {
          const name = stringParam(params, "name")?.trim();
          if (!name) throw new Error("缺少 name（MCP Server 名称）。");
          replyOk({ result: await host.logoutMcpServer(name) });
          return;
        }
        case "mcp_set_session_enabled": {
          const name = stringParam(params, "name")?.trim();
          if (!name) throw new Error("缺少 name（MCP Server 名称）。");
          if (typeof params?.enabled !== "boolean") throw new Error("缺少 enabled（true/false）。");
          replyOk({ inspection: await host.setSessionMcpServerEnabled(name, params.enabled) });
          return;
        }
        case "model_list": {
          replyOk({ configuration: await host.getModelProviderConfiguration() });
          return;
        }
        case "model_save": {
          if (!isRecord(params?.provider)) throw new Error("缺少 provider（要保存的服务商配置）。");
          replyOk({ result: await host.saveModelProviderPatch(params.provider as unknown as ModelProviderPatchInput) });
          return;
        }
        case "model_remove": {
          const provider = providerIdParam(params);
          if (!provider) throw new Error("缺少 providerId（服务商 ID）。");
          replyOk({ configuration: await host.removeModelProviderConfiguration(provider) });
          return;
        }
        case "model_set_enabled": {
          const provider = providerIdParam(params);
          if (!provider) throw new Error("缺少 providerId（服务商 ID）。");
          if (typeof params?.enabled !== "boolean") throw new Error("缺少 enabled（true/false）。");
          replyOk({ result: await host.setModelProviderEnabled(provider, params.enabled) });
          return;
        }
        case "model_fetch_models": {
          const result = await host.fetchProviderModels(providerFetchInput(params));
          const metadata = await host.getModelCatalogMetadata(result.models.map((model) => model.id), params?.refresh === true);
          const metadataById = new Map(metadata.entries.map((entry) => [entry.modelId, entry]));
          const enrichedModels = result.models.map((model) => {
            const meta = metadataById.get(model.id);
            if (!meta) return model;
            return {
              ...model,
              name: model.name ?? meta.name,
              contextWindow: meta.contextWindow,
              maxTokens: meta.maxTokens,
              reasoning: meta.reasoning,
              input: meta.input,
              thinkingLevels: meta.thinkingLevels,
              catalogSources: meta.sources,
            };
          });
          replyOk({ result: { ...result, models: enrichedModels }, metadata });
          return;
        }
        case "model_catalog": {
          const modelIds = params?.modelIds;
          if (!Array.isArray(modelIds) || !modelIds.every((id) => typeof id === "string")) {
            throw new Error("缺少 modelIds（模型 ID 数组）。");
          }
          replyOk({ metadata: await host.getModelCatalogMetadata(modelIds, params?.refresh === true) });
          return;
        }
        case "model_test": {
          replyOk({ result: await host.testProviderConnection(providerTestInput(params)) });
          return;
        }
        case "model_auth_start": {
          const provider = providerIdParam(params);
          if (!provider) throw new Error("缺少 providerId（服务商 ID）。");
          const state = await host.startModelProviderOAuth(provider);
          replyOk({ result: await host.getModelProviderOAuth(state.flowId) });
          return;
        }
        case "model_auth_status": {
          const flowId = stringParam(params, "flowId")?.trim();
          if (!flowId) throw new Error("缺少 flowId（订阅登录流程 ID）。");
          replyOk({ result: await host.getModelProviderOAuth(flowId) });
          return;
        }
        case "model_auth_await": {
          const flowId = stringParam(params, "flowId")?.trim();
          if (!flowId) throw new Error("缺少 flowId（订阅登录流程 ID）。");
          const revision = typeof params?.revision === "number" ? params.revision : undefined;
          const timeoutMs = typeof params?.timeoutMs === "number" ? params.timeoutMs : undefined;
          replyOk({ result: await host.awaitModelProviderOAuth(flowId, revision, timeoutMs) });
          return;
        }
        case "model_auth_respond": {
          const flowId = stringParam(params, "flowId")?.trim();
          const promptId = stringParam(params, "promptId")?.trim();
          const value = stringParam(params, "value");
          if (!flowId || !promptId || value === undefined) throw new Error("缺少 flowId、promptId 或 value（订阅登录输入）。");
          await host.respondModelProviderOAuth(flowId, promptId, value);
          replyOk({ result: await host.getModelProviderOAuth(flowId) });
          return;
        }
        case "model_auth_cancel": {
          const flowId = stringParam(params, "flowId")?.trim();
          if (!flowId) throw new Error("缺少 flowId（订阅登录流程 ID）。");
          await host.cancelModelProviderOAuth(flowId);
          replyOk({ result: { cancelled: true } });
          return;
        }
        case "model_logout": {
          const provider = providerIdParam(params);
          if (!provider) throw new Error("缺少 providerId（服务商 ID）。");
          replyOk({ configuration: await host.removeProviderAuth(provider) });
          return;
        }
        case "model_ws_get": {
          replyOk({ configuration: await host.getOpenAIResponsesWsConfiguration() });
          return;
        }
        case "model_ws_save": {
          const raw = isRecord(params?.ws) ? params.ws : params;
          const baseUrl = stringValue(raw?.baseUrl).trim();
          if (!baseUrl) throw new Error("缺少 baseUrl（OpenAI Responses WS 地址）。");
          const input: OpenAIResponsesWsConfigurationInput = {
            baseUrl,
            apiKey: typeof raw?.apiKey === "string" ? raw.apiKey : undefined,
            preserveApiKey: raw?.preserveApiKey !== false,
            fast: raw?.fast === true,
          };
          replyOk({
            configuration: await host.saveOpenAIResponsesWsConfiguration(input),
            ws: await host.getOpenAIResponsesWsConfiguration(),
          });
          return;
        }
        case "skill_list": {
          replyOk({ configuration: await host.getSkillConfiguration(cwd) });
          return;
        }
        case "skill_set_enabled": {
          const filePath = stringParam(params, "filePath")?.trim();
          if (!filePath) throw new Error("缺少 filePath（Skill 路径）。");
          if (typeof params?.enabled !== "boolean") throw new Error("缺少 enabled（true/false）。");
          replyOk({ configuration: await host.setSkillEnabled(filePath, params.enabled, cwd) });
          return;
        }
        case "skill_remove": {
          const filePath = stringParam(params, "filePath")?.trim();
          if (!filePath) throw new Error("缺少 filePath（Skill 路径）。");
          replyOk({ configuration: await host.removeSkill(filePath, cwd) });
          return;
        }
        case "skill_delete": {
          const filePath = stringParam(params, "filePath")?.trim();
          if (!filePath) throw new Error("缺少 filePath（Skill 路径）。");
          replyOk({ configuration: await host.deleteSkill(filePath, cwd) });
          return;
        }
        case "skill_install": {
          const path = stringParam(params, "path")?.trim();
          if (!path) throw new Error("缺少 path（Skill 目录）。");
          replyOk({ configuration: await host.addSkillPath(path, cwd) });
          return;
        }
        case "skill_remove_path": {
          const path = stringParam(params, "path")?.trim();
          if (!path) throw new Error("缺少 path（Skill 目录）。");
          replyOk({ configuration: await host.removeSkillPath(path, cwd) });
          return;
        }
        case "skill_set_session_enabled": {
          const filePath = stringParam(params, "filePath")?.trim();
          if (!filePath) throw new Error("缺少 filePath（Skill 路径）。");
          if (typeof params?.enabled !== "boolean") throw new Error("缺少 enabled（true/false）。");
          replyOk({ inspection: await host.setSessionSkillEnabled(filePath, params.enabled) });
          return;
        }
        default: {
          const exhaustive: never = request.method;
          replyError(`不支持的配置方法：${stringValue((request as { method?: unknown }).method)}`);
          void exhaustive;
          return;
        }
      }
    } catch (error) {
      // 红线画在这里：敏感值在 runtime 侧就脱敏，错误文本里带出来的 token 也一样。
      const secrets = await hostSensitiveValues(host, cwd, params).catch(() => setupParamSensitiveValues(params));
      replyError(redactSensitiveText(errorMessage(error), secrets));
    }
  });
}
