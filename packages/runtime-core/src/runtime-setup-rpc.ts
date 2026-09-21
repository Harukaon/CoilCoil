import type {
  ImportMcpServersInput,
  McpConfigurationSnapshot,
  McpDiscoveryResult,
  McpImportConfiguration,
  McpJsonDocument,
  McpServerConfiguration,
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

async function hostSensitiveValues(host: SetupRpcHost, cwd?: string): Promise<string[]> {
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
    return secrets;
  } catch {
    return [];
  }
}

/**
 * Answer the `coilcoil` tool's setup operations over the session event bus.
 *
 * Installed when the session is created so it is in place before any tool
 * call can ask. Session switches swap the whole bus, so a request that
 * arrives late answers for nobody — `requireActive` guards that.
 */
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
      const secrets = await hostSensitiveValues(host, cwd).catch(() => [] as string[]);
      replyError(redactSensitiveText(errorMessage(error), secrets));
    }
  });
}
