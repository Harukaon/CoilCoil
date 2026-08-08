import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const mcpAdapter = (jiti("pi-mcp-adapter") as { default: (pi: ExtensionAPI) => void }).default;
const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";

interface McpStatusSnapshot {
  version: 1;
  servers: Array<{
    name: string;
    status: "connected" | "cached" | "failed" | "needs-auth" | "not-connected" | "disabled";
    toolCount: number;
    resourceCount?: number;
    failedAgoSeconds?: number;
    disabled: boolean;
  }>;
  totalTools: number;
  totalResources: number;
  connectedCount: number;
  disabledCount: number;
}

export const MCP_RPC_PROTOCOL_VERSION = 1;
export const MCP_RPC_REQUEST_EVENT = "suocode:mcp:rpc:v1:request";
export const MCP_RPC_REPLY_EVENT_PREFIX = "suocode:mcp:rpc:v1:reply:";

type McpRpcMethod = "status" | "connect" | "auth-start" | "auth-complete" | "logout";

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
  if (raw.method !== "status" && raw.method !== "connect" && raw.method !== "auth-start" && raw.method !== "auth-complete" && raw.method !== "logout") {
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

export default function suocodeMcpAdapter(pi: ExtensionAPI): void {
  let proxyTool: McpProxyTool | undefined;
  let mcpCommand: { handler: (args: string, context: ExtensionCommandContext) => Promise<void> } | undefined;
  let context: ExtensionContext | undefined;
  let statusSnapshot: McpStatusSnapshot | undefined;
  const registerTool = pi.registerTool.bind(pi);
  const registerCommand = pi.registerCommand.bind(pi);

  pi.registerTool = ((tool: McpProxyTool) => {
    if (tool.name === "mcp") proxyTool = tool;
    registerTool(tool);
  }) as ExtensionAPI["registerTool"];
  pi.registerCommand = ((name, command) => {
    if (name === "mcp") mcpCommand = command;
    registerCommand(name, command);
  }) as ExtensionAPI["registerCommand"];
  mcpAdapter(pi);
  pi.registerTool = registerTool as ExtensionAPI["registerTool"];
  pi.registerCommand = registerCommand as ExtensionAPI["registerCommand"];

  const unsubscribeStatus = pi.events.on(MCP_STATUS_EVENT, (raw) => {
    if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.servers)) return;
    statusSnapshot = raw as unknown as McpStatusSnapshot;
  });

  pi.on("session_start", async (_event, nextContext) => {
    context = nextContext;
  });
  const unsubscribeRpc = pi.events.on(MCP_RPC_REQUEST_EVENT, async (raw) => {
    let id = "unknown";
    try {
      id = requestId(raw);
      const request = parseRequest(raw);
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
        data: { text: resultText(result), details },
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
    unsubscribeStatus();
    unsubscribeRpc();
  });
}
