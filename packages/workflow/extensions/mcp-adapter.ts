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
const mcpAdapter = (jiti("pi-mcp-adapter") as { default: (pi: ExtensionAPI) => void }).default;
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
const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";
const MCP_TOOL_APPROVAL_REQUEST_EVENT = "pi-mcp-adapter:tool-approval-request";
const MCP_SESSION_POLICY_ENTRY = "suocode-mcp-session-policy";

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
export const MCP_RPC_REQUEST_EVENT = "suocode:mcp:rpc:v1:request";
export const MCP_RPC_REPLY_EVENT_PREFIX = "suocode:mcp:rpc:v1:reply:";

type McpRpcMethod = "status" | "connect" | "auth-start" | "auth-complete" | "logout" | "session-enable";

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

function requestId(raw: unknown): string {
  if (!isRecord(raw) || typeof raw.requestId !== "string" || !raw.requestId.trim() || /[\r\n]/.test(raw.requestId)) {
    throw new Error("MCP RPC requestId 无效。");
  }
  return raw.requestId;
}

function parseRequest(raw: unknown): McpRpcRequest {
  const id = requestId(raw);
  if (!isRecord(raw) || raw.version !== MCP_RPC_PROTOCOL_VERSION) throw new Error("MCP RPC 版本不受支持。");
  if (raw.method !== "status" && raw.method !== "connect" && raw.method !== "auth-start" && raw.method !== "auth-complete" && raw.method !== "logout" && raw.method !== "session-enable") {
    throw new Error("MCP RPC 方法不受支持。");
  }
  return {
    version: MCP_RPC_PROTOCOL_VERSION,
    requestId: id,
    method: raw.method,
    params: isRecord(raw.params) ? raw.params : {},
  };
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

export default function suocodeMcpAdapter(pi: ExtensionAPI): void {
  let proxyTool: McpProxyTool | undefined;
  let rawProxyTool: McpProxyTool | undefined;
  let mcpCommand: { handler: (args: string, context: ExtensionCommandContext) => Promise<void> } | undefined;
  let context: ExtensionContext | undefined;
  let statusSnapshot: McpStatusSnapshot | undefined;
  const sessionDisabledServers = new Set<string>();
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

  const refreshDirectToolOwnership = (): void => {
    try {
      const config = loadMcpConfig(undefined, context?.cwd ?? process.cwd());
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
      `suocode-mcp-session-tools-${Date.now()}`,
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
  mcpAdapter(pi);
  pi.registerCommand = registerCommand as ExtensionAPI["registerCommand"];

  const unsubscribeStatus = pi.events.on(MCP_STATUS_EVENT, (raw) => {
    if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.servers)) return;
    statusSnapshot = raw as unknown as McpStatusSnapshot;
    refreshDirectToolOwnership();
    for (const server of sessionDisabledServers) void refreshServerTools(server).catch(() => undefined);
  });

  const unsubscribeApproval = pi.events.on(MCP_TOOL_APPROVAL_REQUEST_EVENT, (raw) => {
    if (!isRecord(raw) || typeof raw.serverName !== "string" || !sessionDisabledServers.has(raw.serverName)) return;
    if (typeof raw.claim === "function") raw.claim(() => "deny");
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
          `suocode-mcp-session-status-${request.requestId}`,
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
      if (!proxyTool) throw new Error("pi-mcp-adapter 没有注册 MCP 代理工具。");
      const result = await proxyTool.execute(
        `suocode-mcp-rpc-${request.requestId}`,
        proxyParams(request),
        context?.signal,
        undefined,
        context ?? ({} as ExtensionContext),
      ) as McpProxyResult;
      if (result.isError) throw new Error(resultText(result) || "MCP 扩展请求失败。");
      const details = request.method === "status" && statusSnapshot
        ? { ...statusSnapshot, ...(isRecord(result.details) ? result.details : {}), mode: "status" }
        : result.details;
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
    if (pi.registerTool === wrappedRegisterTool) pi.registerTool = registerTool as ExtensionAPI["registerTool"];
    unsubscribeStatus();
    unsubscribeApproval();
    unsubscribeRpc();
  });
}
