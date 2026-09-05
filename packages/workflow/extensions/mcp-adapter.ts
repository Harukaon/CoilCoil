import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const jiti = createJiti(import.meta.url);
interface McpAdapterConfiguration {
  imports?: string[];
  mcpServers: Record<string, Record<string, unknown>>;
  settings?: Record<string, unknown>;
}

const adapterModule = jiti("pi-mcp-adapter") as {
  default: (pi: ExtensionAPI) => void;
  createMcpAdapter: (options?: { config?: McpAdapterConfiguration }) => (pi: ExtensionAPI) => void;
};
const defaultMcpAdapter = adapterModule.default;
const createMcpAdapter = adapterModule.createMcpAdapter;
const adapterDirectory = dirname(createRequire(import.meta.url).resolve("pi-mcp-adapter"));
const { loadMcpConfig } = jiti(join(adapterDirectory, "config.ts")) as {
  loadMcpConfig: (overridePath?: string, cwd?: string) => unknown;
};
const { loadMetadataCache } = jiti(join(adapterDirectory, "metadata-cache.ts")) as {
  loadMetadataCache: () => unknown;
};
const { resolveDirectTools } = jiti(join(adapterDirectory, "direct-tools.ts")) as {
  resolveDirectTools: (config: unknown, cache: unknown, prefix: string, envOverride?: string[]) => Array<{ serverName: string; prefixedName: string }>;
};
/**
 * The loopback listener pi already binds for OAuth redirects.
 *
 * `auth-start` only *reserves* the flow's state on that listener; nobody waits
 * for the redirect, so the browser lands on "copy this URL back into Pi" and
 * the authorization code is dropped on the floor. Claiming the same singleton
 * through the same jiti instance — the module identity pi's own
 * `mcp-auth-flow.ts` uses — lets the GUI wait for the callback the way the
 * terminal flow does, and finish the exchange without anyone pasting anything.
 */
const { waitForCallback, cancelPendingCallback } = jiti(join(adapterDirectory, "mcp-callback-server.ts")) as {
  waitForCallback: (oauthState: string) => Promise<OAuthCallbackResult>;
  cancelPendingCallback: (oauthState: string) => void;
};

interface OAuthCallbackResult {
  code: string;
  /** RFC 9207 `iss`, when the authorization server sends one. */
  iss?: string;
}
const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";
const MCP_TOOL_APPROVAL_REQUEST_EVENT = "pi-mcp-adapter:tool-approval-request";
const MCP_SESSION_POLICY_ENTRY = "coilcoil-mcp-session-policy";
const MCP_AGENT_CONFIG_REGISTRY = Symbol.for("coilcoil-workflow.mcp-agent-config-registry");
const MCP_AGENT_CONFIG_CHANNEL = "coilcoil:mcp:agent-config:v1";

interface McpStatusSnapshot {
  version: 1;
  servers: Array<{
    name: string;
    status: "connected" | "cached" | "failed" | "needs-auth" | "not-connected" | "disabled";
    toolCount: number;
    resourceCount?: number;
    failedAgoSeconds?: number;
    disabled: boolean;
    sessionDisabled?: boolean;
  }>;
  totalTools: number;
  totalResources: number;
  connectedCount: number;
  disabledCount: number;
}

export const MCP_RPC_PROTOCOL_VERSION = 1;
export const MCP_RPC_REQUEST_EVENT = "coilcoil:mcp:rpc:v1:request";
export const MCP_RPC_REPLY_EVENT_PREFIX = "coilcoil:mcp:rpc:v1:reply:";

type McpRpcMethod = "status" | "connect" | "auth-start" | "auth-await" | "auth-cancel" | "auth-complete" | "logout" | "session-enable";

interface McpRpcRequest {
  version: typeof MCP_RPC_PROTOCOL_VERSION;
  requestId: string;
  method: McpRpcMethod;
  params?: Record<string, unknown>;
}

interface McpProxyResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

type McpProxyTool = ToolDefinition<any, unknown, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * CoilCoil's own MCP server list, including the bundled browser server.
 *
 * Asked for over the event bus rather than looked up by object identity: Pi
 * hands each extension a `{emit, on}` wrapper around the bus, not the bus
 * itself, so the old WeakMap lookup always missed and this fell back to the raw
 * config files — which is how the built-in browser server disappeared and
 * removed servers came back. Emitting is synchronous, so the answer is present
 * as soon as `emit` returns. The WeakMap is still tried first for older hosts
 * that really do pass the bus.
 */
export function registeredMcpConfiguration(events: {
  emit(channel: string, data: unknown): void;
}): McpAdapterConfiguration | undefined {
  const registry = (globalThis as Record<PropertyKey, unknown>)[MCP_AGENT_CONFIG_REGISTRY];
  const direct = registry instanceof WeakMap
    ? registry.get(events) as McpAdapterConfiguration | undefined
    : undefined;
  if (direct && isRecord(direct.mcpServers)) return direct;

  const request: { configuration?: McpAdapterConfiguration } = {};
  try {
    events.emit(MCP_AGENT_CONFIG_CHANNEL, request);
  } catch {
    return undefined;
  }
  const supplied = request.configuration;
  return supplied && isRecord(supplied.mcpServers) ? supplied : undefined;
}

function requestId(raw: unknown): string {
  if (!isRecord(raw) || typeof raw.requestId !== "string" || !raw.requestId.trim() || /[\r\n]/.test(raw.requestId)) {
    throw new Error("MCP RPC requestId 无效。");
  }
  return raw.requestId;
}

const MCP_RPC_METHODS: readonly McpRpcMethod[] = [
  "status",
  "connect",
  "auth-start",
  "auth-await",
  "auth-cancel",
  "auth-complete",
  "logout",
  "session-enable",
];

function parseRequest(raw: unknown): McpRpcRequest {
  const id = requestId(raw);
  if (!isRecord(raw) || raw.version !== MCP_RPC_PROTOCOL_VERSION) throw new Error("MCP RPC 版本不受支持。");
  const method = raw.method as McpRpcMethod;
  if (typeof raw.method !== "string" || !MCP_RPC_METHODS.includes(method)) {
    throw new Error("MCP RPC 方法不受支持。");
  }
  return {
    version: MCP_RPC_PROTOCOL_VERSION,
    requestId: id,
    method,
    params: isRecord(raw.params) ? raw.params : {},
  };
}

/**
 * The `state` pi generated for this authorization request.
 *
 * It is the key the loopback listener files the redirect under, and the
 * authorization URL is the only place the GUI bridge can read it from: pi keeps
 * it in module-private runtime state.
 */
export function oauthStateFromAuthorizationUrl(authorizationUrl: unknown): string | undefined {
  if (typeof authorizationUrl !== "string" || !authorizationUrl.trim()) return undefined;
  try {
    const state = new URL(authorizationUrl).searchParams.get("state");
    return state?.trim() ? state : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rebuild the redirect pi's `auth-complete` expects to be pasted by hand.
 *
 * `parseAuthorizationRedirectInput` accepts a bare query string and re-checks
 * `state` against the pending flow, so the captured callback is handed back in
 * exactly the shape a human would have copied out of the address bar.
 */
export function authorizationRedirectInput(result: OAuthCallbackResult, oauthState: string): string {
  const params = new URLSearchParams({ code: result.code, state: oauthState });
  if (result.iss) params.set("iss", result.iss);
  return `?${params.toString()}`;
}

function serverName(params: Record<string, unknown>): string {
  const value = typeof params.server === "string" ? params.server.trim() : "";
  if (!value) throw new Error("缺少 MCP Server 名称。");
  return value;
}

function proxyParams(request: McpRpcRequest): Record<string, unknown> {
  const params = request.params ?? {};
  if (request.method === "status") return {};
  if (request.method === "session-enable") return {};
  if (request.method === "connect") return { connect: serverName(params) };
  if (request.method === "auth-start") return { action: "auth-start", server: serverName(params) };
  if (request.method === "logout") return { server: serverName(params) };
  const input = typeof params.input === "string" ? params.input.trim() : "";
  if (!input) throw new Error("缺少 OAuth 回调内容。");
  return { action: "auth-complete", server: serverName(params), args: JSON.stringify({ input }) };
}

function resultText(result: McpProxyResult): string {
  return result.content.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n");
}

export function requestedMcpServer(params: unknown, serverTools: ReadonlyMap<string, ReadonlySet<string>>): string | undefined {
  if (!isRecord(params)) return undefined;
  for (const key of ["server", "connect", "describe", "instructions"] as const) {
    if (typeof params[key] === "string" && params[key].trim()) return params[key].trim();
  }
  const toolName = typeof params.tool === "string" ? params.tool.trim() : "";
  if (!toolName) return undefined;
  for (const [server, tools] of serverTools) if (tools.has(toolName)) return server;
  return undefined;
}

export function decorateMcpStatusForSession(details: unknown, disabledServers: ReadonlySet<string>): unknown {
  if (!isRecord(details) || !Array.isArray(details.servers)) return details;
  const servers = details.servers.map((raw) => {
    if (!isRecord(raw)) return raw;
    const name = typeof raw.name === "string" ? raw.name : "";
    return { ...raw, sessionDisabled: Boolean(name && raw.disabled !== true && disabledServers.has(name)) };
  });
  const available = servers.filter((raw) => isRecord(raw) && raw.disabled !== true && raw.sessionDisabled !== true);
  return {
    ...details,
    mode: "status",
    servers,
    connectedCount: available.filter((raw) => raw.status === "connected").length,
    totalTools: available.reduce((total, raw) => total + (typeof raw.toolCount === "number" ? raw.toolCount : 0), 0),
    totalResources: available.reduce((total, raw) => total + (typeof raw.resourceCount === "number" ? raw.resourceCount : 0), 0),
    sessionDisabledCount: servers.filter((raw) => isRecord(raw) && raw.sessionDisabled === true).length,
  };
}

function blockedServerResult(server: string): McpProxyResult {
  return {
    content: [{ type: "text", text: `MCP Server \"${server}\" 已在当前会话停用。` }],
    details: { mode: "session-policy", server, sessionDisabled: true },
    isError: true,
  };
}

function disabledServersFromSession(context: ExtensionContext): string[] {
  const entries = context.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== MCP_SESSION_POLICY_ENTRY || !isRecord(entry.data)) continue;
    if (!Array.isArray(entry.data.disabledServers)) return [];
    return entry.data.disabledServers.filter((name): name is string => typeof name === "string" && Boolean(name.trim()));
  }
  return [];
}

export default function coilcoilMcpAdapter(pi: ExtensionAPI): void {
  const suppliedConfiguration = registeredMcpConfiguration(pi.events);
  const installMcpAdapter = suppliedConfiguration
    ? createMcpAdapter({ config: suppliedConfiguration })
    : defaultMcpAdapter;
  let proxyTool: McpProxyTool | undefined;
  let rawProxyTool: McpProxyTool | undefined;
  let mcpCommand: { handler: (args: string, context: ExtensionCommandContext) => Promise<void> } | undefined;
  let context: ExtensionContext | undefined;
  let statusSnapshot: McpStatusSnapshot | undefined;
  const sessionDisabledServers = new Set<string>();
  /** Browser authorizations whose loopback redirect this bridge is waiting on. */
  const pendingBrowserAuths = new Map<string, { oauthState: string; callback: Promise<OAuthCallbackResult> }>();
  const serverProxyTools = new Map<string, Set<string>>();
  const serverDirectTools = new Map<string, Set<string>>();
  const hiddenDirectTools = new Set<string>();
  const registerTool = pi.registerTool.bind(pi);
  const registerCommand = pi.registerCommand.bind(pi);

  const syncSessionToolVisibility = (): void => {
    const active = pi.getActiveTools?.();
    if (!active) return;
    const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
    const next = new Set(active);
    for (const name of [...hiddenDirectTools]) {
      const stillDisabled = [...serverDirectTools].some(([server, tools]) => sessionDisabledServers.has(server) && tools.has(name));
      if (stillDisabled) continue;
      hiddenDirectTools.delete(name);
      if (allToolNames.has(name)) next.add(name);
    }
    for (const server of sessionDisabledServers) {
      for (const name of serverDirectTools.get(server) ?? []) {
        if (next.delete(name)) hiddenDirectTools.add(name);
      }
    }
    const current = [...active];
    const desired = [...next];
    if (current.length !== desired.length || current.some((name) => !next.has(name))) pi.setActiveTools(desired);
  };

  /** Stop waiting for a server's redirect and free its slot on the listener. */
  const forgetBrowserAuth = (server: string): void => {
    const pending = pendingBrowserAuths.get(server);
    if (!pending) return;
    pendingBrowserAuths.delete(server);
    try {
      cancelPendingCallback(pending.oauthState);
    } catch {
      // The listener may already have shut down with the OAuth runtime.
    }
  };

  /**
   * Claim the redirect for an authorization that just started.
   *
   * Registered before `auth-start` replies, so the listener is holding a waiter
   * by the time the caller opens the browser — otherwise a fast approval lands
   * on the "paste this back into Pi" page and the code is lost.
   */
  const claimBrowserAuth = (server: string, details: unknown): boolean => {
    forgetBrowserAuth(server);
    const oauthState = oauthStateFromAuthorizationUrl(isRecord(details) ? details.authorizationUrl : undefined);
    if (!oauthState) return false;
    const callback = waitForCallback(oauthState);
    // Nobody is attached until `auth-await` arrives; a timeout in between must
    // not surface as an unhandled rejection.
    callback.catch(() => undefined);
    pendingBrowserAuths.set(server, { oauthState, callback });
    return true;
  };

  const refreshDirectToolOwnership = (): void => {
    try {
      const config = suppliedConfiguration ?? loadMcpConfig(undefined, context?.cwd ?? process.cwd());
      const cache = loadMetadataCache();
      const settings = isRecord(config) && isRecord(config.settings) ? config.settings : undefined;
      const prefix = settings && typeof settings.toolPrefix === "string" ? settings.toolPrefix : "server";
      const envRaw = process.env.MCP_DIRECT_TOOLS;
      const envOverride = envRaw?.split(",").map((value) => value.trim()).filter(Boolean);
      const specs = resolveDirectTools(config, cache, prefix, envOverride);
      serverDirectTools.clear();
      for (const spec of specs) {
        const names = serverDirectTools.get(spec.serverName) ?? new Set<string>();
        names.add(spec.prefixedName);
        serverDirectTools.set(spec.serverName, names);
      }
    } catch {
      // The adapter can still enforce the execution gate through its public
      // approval event if metadata is temporarily unavailable.
    }
  };

  const directToolOwner = (toolName: string): string | undefined => {
    refreshDirectToolOwnership();
    for (const [server, tools] of serverDirectTools) if (tools.has(toolName)) return server;
    return undefined;
  };

  const rememberServerTools = (server: string, details: unknown): void => {
    if (!isRecord(details) || details.mode !== "list" || !Array.isArray(details.tools)) return;
    serverProxyTools.set(server, new Set(details.tools.filter((name): name is string => typeof name === "string" && Boolean(name.trim()))));
    syncSessionToolVisibility();
  };

  const refreshServerTools = async (server: string): Promise<void> => {
    if (!rawProxyTool || !context) return;
    const result = await rawProxyTool.execute(
      `coilcoil-mcp-session-tools-${Date.now()}`,
      { server },
      context.signal,
      undefined,
      context,
    ) as McpProxyResult;
    if (!result.isError) rememberServerTools(server, result.details);
  };

  const decorateStatus = (details: unknown): unknown => decorateMcpStatusForSession(details, sessionDisabledServers);

  const wrappedRegisterTool = ((tool: McpProxyTool) => {
    if (tool.name !== "mcp") {
      const owner = directToolOwner(tool.name);
      const guarded = owner ? {
        ...tool,
        execute: (async (...args: Parameters<McpProxyTool["execute"]>) => (
          sessionDisabledServers.has(owner)
            ? blockedServerResult(owner)
            : tool.execute(...args)
        )) as McpProxyTool["execute"],
      } : tool;
      registerTool(guarded);
      // Pi action APIs (getActiveTools/getAllTools/setActiveTools) are not
      // available while extensions are still being loaded. Direct MCP tools
      // can also be registered later after metadata refresh, so synchronize
      // immediately only once the Session context exists; session_start does
      // the initial pass for tools registered during loading.
      if (context) syncSessionToolVisibility();
      return;
    }
    rawProxyTool = tool;
    const wrapped: McpProxyTool = {
      ...tool,
      execute: (async (...args: Parameters<McpProxyTool["execute"]>) => {
        const server = requestedMcpServer(args[1], serverProxyTools);
        if (server && sessionDisabledServers.has(server)) return blockedServerResult(server);
        const result = await tool.execute(...args) as McpProxyResult;
        if (server) rememberServerTools(server, result.details);
        if (isRecord(result.details) && result.details.mode === "status") {
          return { ...result, details: decorateStatus(result.details) };
        }
        return result;
      }) as McpProxyTool["execute"],
    };
    proxyTool = wrapped;
    registerTool(wrapped);
  }) as ExtensionAPI["registerTool"];
  pi.registerTool = wrappedRegisterTool;
  pi.registerCommand = ((name, command) => {
    if (name === "mcp") mcpCommand = command;
    registerCommand(name, command);
  }) as ExtensionAPI["registerCommand"];
  installMcpAdapter(pi);
  pi.registerCommand = registerCommand as ExtensionAPI["registerCommand"];

  const unsubscribeStatus = pi.events.on(MCP_STATUS_EVENT, (raw) => {
    if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.servers)) return;
    statusSnapshot = raw as unknown as McpStatusSnapshot;
    refreshDirectToolOwnership();
    for (const server of sessionDisabledServers) void refreshServerTools(server).catch(() => undefined);
  });

  const unsubscribeApproval = pi.events.on(MCP_TOOL_APPROVAL_REQUEST_EVENT, (raw) => {
    if (!isRecord(raw) || typeof raw.serverName !== "string" || typeof raw.claim !== "function") return;
    if (sessionDisabledServers.has(raw.serverName)) {
      raw.claim(() => "deny");
      return;
    }
  });

  pi.on("session_start", async (_event, nextContext) => {
    context = nextContext;
    sessionDisabledServers.clear();
    for (const server of disabledServersFromSession(nextContext)) sessionDisabledServers.add(server);
    refreshDirectToolOwnership();
    for (const server of sessionDisabledServers) await refreshServerTools(server).catch(() => undefined);
    syncSessionToolVisibility();
  });
  pi.on("session_tree", async (_event, nextContext) => {
    context = nextContext;
    sessionDisabledServers.clear();
    for (const server of disabledServersFromSession(nextContext)) sessionDisabledServers.add(server);
    refreshDirectToolOwnership();
    for (const server of sessionDisabledServers) await refreshServerTools(server).catch(() => undefined);
    syncSessionToolVisibility();
  });
  const unsubscribeRpc = pi.events.on(MCP_RPC_REQUEST_EVENT, async (raw) => {
    let id = "unknown";
    try {
      id = requestId(raw);
      const request = parseRequest(raw);
      if (request.method === "session-enable") {
        if (!context) throw new Error("当前会话尚未就绪。");
        if (!proxyTool) throw new Error("pi-mcp-adapter 的代理工具尚未就绪。");
        const name = serverName(request.params ?? {});
        const enabled = request.params?.enabled === true;
        const statusResult = await proxyTool.execute(
          `coilcoil-mcp-session-status-${request.requestId}`,
          {},
          context.signal,
          undefined,
          context,
        ) as McpProxyResult;
        const statusServers = isRecord(statusResult.details) && Array.isArray(statusResult.details.servers)
          ? statusResult.details.servers
          : statusSnapshot?.servers ?? [];
        const configuredServer = statusServers.find((server) => isRecord(server) && server.name === name);
        if (!configuredServer) throw new Error(`未找到 MCP Server：${name}`);
        if (enabled && configuredServer.disabled === true) {
          throw new Error(`${name} 已在工作区设置中停用，请先在设置页启用。`);
        }
        if (enabled) sessionDisabledServers.delete(name);
        else sessionDisabledServers.add(name);
        refreshDirectToolOwnership();
        await refreshServerTools(name).catch(() => undefined);
        syncSessionToolVisibility();
        pi.appendEntry(MCP_SESSION_POLICY_ENTRY, { version: 1, disabledServers: [...sessionDisabledServers].sort() });
        pi.events.emit(`${MCP_RPC_REPLY_EVENT_PREFIX}${request.requestId}`, {
          version: MCP_RPC_PROTOCOL_VERSION,
          requestId: request.requestId,
          method: request.method,
          success: true,
          data: {
            text: enabled ? `${name} 已在当前会话启用。` : `${name} 已在当前会话停用。`,
            details: decorateStatus(statusResult.details ?? statusSnapshot),
          },
        });
        return;
      }
      if (request.method === "logout") {
        if (!mcpCommand || !context) throw new Error("pi-mcp-adapter 的登出命令尚未就绪。");
        const name = serverName(request.params ?? {});
        await mcpCommand.handler(`logout ${name}`, context as ExtensionCommandContext);
        pi.events.emit(`${MCP_RPC_REPLY_EVENT_PREFIX}${request.requestId}`, {
          version: MCP_RPC_PROTOCOL_VERSION,
          requestId: request.requestId,
          method: request.method,
          success: true,
          data: {
            text: `已通过 pi-mcp-adapter 清除 ${name} 的 OAuth 凭据。`,
            details: { mode: "logout", server: name, loggedOut: true },
          },
        });
        return;
      }
      if (request.method === "auth-cancel") {
        const name = serverName(request.params ?? {});
        forgetBrowserAuth(name);
        pi.events.emit(`${MCP_RPC_REPLY_EVENT_PREFIX}${request.requestId}`, {
          version: MCP_RPC_PROTOCOL_VERSION,
          requestId: request.requestId,
          method: request.method,
          success: true,
          data: {
            text: `已停止等待 ${name} 的浏览器授权。`,
            details: { mode: "auth-cancel", server: name },
          },
        });
        return;
      }
      if (request.method === "auth-await") {
        if (!proxyTool) throw new Error("pi-mcp-adapter 没有注册 MCP 代理工具。");
        const name = serverName(request.params ?? {});
        const pending = pendingBrowserAuths.get(name);
        if (!pending) throw new Error(`${name} 没有正在等待的浏览器授权，请重新开始认证。`);
        let callback: OAuthCallbackResult;
        try {
          callback = await pending.callback;
        } finally {
          if (pendingBrowserAuths.get(name) === pending) pendingBrowserAuths.delete(name);
        }
        // The redirect is handed to pi's own `auth-complete`, which re-checks
        // the state and runs the PKCE token exchange; this bridge never touches
        // the code beyond passing it along.
        const completion = await proxyTool.execute(
          `coilcoil-mcp-rpc-${request.requestId}`,
          {
            action: "auth-complete",
            server: name,
            args: JSON.stringify({ input: authorizationRedirectInput(callback, pending.oauthState) }),
          },
          context?.signal,
          undefined,
          context ?? ({} as ExtensionContext),
        ) as McpProxyResult;
        const completionDetails = isRecord(completion.details) ? completion.details : {};
        if (completion.isError || completionDetails.error) {
          throw new Error(
            (typeof completionDetails.message === "string" ? completionDetails.message : "")
            || resultText(completion)
            || "MCP OAuth 认证没有完成。",
          );
        }
        // A fresh token is worth nothing until the server is reconnected with
        // it, and the user who just approved in a browser expects the server to
        // be usable, not to have to press another button.
        let connected = false;
        try {
          const connection = await proxyTool.execute(
            `coilcoil-mcp-rpc-${request.requestId}-connect`,
            { connect: name },
            context?.signal,
            undefined,
            context ?? ({} as ExtensionContext),
          ) as McpProxyResult;
          connected = !connection.isError && !(isRecord(connection.details) && Boolean(connection.details.error));
        } catch {
          // Authentication still succeeded; the panel's own status refresh will
          // show whatever the connection ends up doing.
        }
        pi.events.emit(`${MCP_RPC_REPLY_EVENT_PREFIX}${request.requestId}`, {
          version: MCP_RPC_PROTOCOL_VERSION,
          requestId: request.requestId,
          method: request.method,
          success: true,
          data: {
            text: connected ? `${name} 已完成认证并重新连接。` : `${name} 已完成认证。`,
            details: { ...completionDetails, mode: "auth-await", server: name, authenticated: true, connected },
          },
        });
        return;
      }
      if (!proxyTool) throw new Error("pi-mcp-adapter 没有注册 MCP 代理工具。");
      const result = await proxyTool.execute(
        `coilcoil-mcp-rpc-${request.requestId}`,
        proxyParams(request),
        context?.signal,
        undefined,
        context ?? ({} as ExtensionContext),
      ) as McpProxyResult;
      if (result.isError) throw new Error(resultText(result) || "MCP 扩展请求失败。");
      let details = request.method === "status" && statusSnapshot
        ? { ...statusSnapshot, ...(isRecord(result.details) ? result.details : {}), mode: "status" }
        : result.details;
      if (request.method === "auth-start") {
        // Claim the redirect before the reply leaves, so the browser the caller
        // is about to open cannot beat this bridge to the loopback listener.
        const awaitingCallback = claimBrowserAuth(serverName(request.params ?? {}), result.details);
        details = { ...(isRecord(details) ? details : {}), awaitingCallback };
      }
      pi.events.emit(`${MCP_RPC_REPLY_EVENT_PREFIX}${request.requestId}`, {
        version: MCP_RPC_PROTOCOL_VERSION,
        requestId: request.requestId,
        method: request.method,
        success: true,
        data: { text: resultText(result), details: request.method === "status" ? decorateStatus(details) : details },
      });
    } catch (error) {
      pi.events.emit(`${MCP_RPC_REPLY_EVENT_PREFIX}${id}`, {
        version: MCP_RPC_PROTOCOL_VERSION,
        requestId: id,
        success: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  });
  pi.on("session_shutdown", async () => {
    context = undefined;
    statusSnapshot = undefined;
    for (const server of [...pendingBrowserAuths.keys()]) forgetBrowserAuth(server);
    if (pi.registerTool === wrappedRegisterTool) pi.registerTool = registerTool as ExtensionAPI["registerTool"];
    unsubscribeStatus();
    unsubscribeApproval();
    unsubscribeRpc();
  });
}
