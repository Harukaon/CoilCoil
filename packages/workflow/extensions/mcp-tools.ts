/**
 * The Agent's door to CoilCoil's MCP servers.
 *
 * This replaces pi-mcp-adapter, and it is deliberately thin. The adapter was a
 * complete second MCP implementation living inside the Pi session — it owned the
 * connections, the credentials and the discovery cache, which is why the
 * settings panel could see none of it and why every rebuild raised a macOS
 * keychain prompt for `pi-mcp-adapter.oauth`. Here the connections belong to the
 * runtime; this file only exposes them to the model.
 *
 * One tool rather than one tool per MCP tool, on purpose: a workspace with a few
 * servers can offer dozens of tools, and putting all of them in the model's
 * schema costs tokens on every single turn whether or not MCP is used at all.
 * `list` is cheap and the model calls it when it needs to know.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { McpManager } from "@coilcoil/mcp";

const TOOL_NAME = "mcp";
export const MCP_MANAGER_CHANNEL = "coilcoil:mcp:manager:v1";

const McpParams = Type.Object({
  action: StringEnum(["list", "tools", "call"], {
    description: "list：列出有哪些 MCP Server（不联网，很快）；tools：连上某一个并列出它的工具；call：调用某个工具",
  }),
  server: Type.Optional(Type.String({ description: "tools 和 call 时必填：MCP Server 名称" })),
  tool: Type.Optional(Type.String({ description: "call 时必填：工具名称" })),
  args: Type.Optional(Type.Object({}, {
    additionalProperties: true,
    description: "call 时传给工具的参数对象；工具没有参数就省略",
  })),
});

interface ManagerRequest {
  manager?: unknown;
}

/**
 * Ask the runtime for its MCP client.
 *
 * Pi hands extensions a `{emit, on}` wrapper rather than the bus itself, so
 * there is nothing to look up by identity; the runtime answers on the channel
 * synchronously, so the reply is present as soon as `emit` returns.
 */
export function requestMcpManager(events: { emit(channel: string, data: unknown): void }): McpManager | undefined {
  const request: ManagerRequest = {};
  try {
    events.emit(MCP_MANAGER_CHANNEL, request);
  } catch {
    return undefined;
  }
  const manager = request.manager;
  return manager && typeof manager === "object" ? manager as McpManager : undefined;
}

function textResult(text: string, details: Record<string, unknown>, isError = false): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError: boolean;
} {
  return { content: [{ type: "text", text }], details, isError };
}

/**
 * Render what the servers offer as something a model can act on directly.
 *
 * Names are qualified by server because two servers routinely ship a `search`
 * or a `read`, and an unqualified list is an invitation to call the wrong one.
 */
export function describeServers(servers: Array<{
  server: string;
  status: string;
  tools: Array<{ name: string }>;
}>): string {
  if (!servers.length) return "当前没有可用的 MCP Server。可能是还没配置，或者配置的都已停用。";
  const lines = servers.map((entry) => {
    if (entry.status === "connected") {
      return `- ${entry.server}（已连接，${entry.tools.length} 个工具：${entry.tools.map((tool) => tool.name).join("、")}）`;
    }
    if (entry.status === "needs-auth") return `- ${entry.server}（需要先在设置里完成认证）`;
    if (entry.status === "failed") return `- ${entry.server}（上次连接失败）`;
    return `- ${entry.server}（未连接，用 action="tools" 查看它有哪些工具）`;
  });
  return [
    "已配置的 MCP Server：",
    ...lines,
    "",
    "这一步没有联网。要知道某个 Server 具体有哪些工具，用 action=\"tools\" 加 server 名字——那一步才会真的去连它，可能要几秒。",
  ].join("\n");
}

/** One server's tools, once the model has decided it wants that one. */
export function describeServerTools(server: string, result: {
  tools: Array<{ name: string; description?: string }>;
  status: string;
  failure?: string;
}): string {
  if (result.status === "needs-auth") return `${server} 需要先在设置里完成认证，然后才能列出工具。`;
  if (result.status === "disabled") return `${server} 已停用。`;
  if (result.status !== "connected") {
    // The server's own words, not a shrug: "Invalid API key" tells the model
    // what to do next, "failed to connect" does not.
    return `${server} 连不上：${result.failure?.split("\n")[0] ?? "没有说明原因"}`;
  }
  if (!result.tools.length) return `${server} 已连接，但没有提供任何工具。`;
  return [
    `${server} 提供的工具：`,
    ...result.tools.map((tool) => `  - ${tool.name}${tool.description ? `：${tool.description}` : ""}`),
  ].join("\n");
}

/**
 * The name one MCP tool gets when it is registered with the Agent directly.
 *
 * Qualified by server because two servers routinely ship a `search`, and the
 * `mcp__` prefix is what the rest of CoilCoil already uses to recognise an MCP
 * tool when accounting for context (see `runtime-token-breakdown.ts`).
 */
export function directToolName(server: string, tool: string): string {
  return `mcp__${server.replace(/-/g, "_")}__${tool}`;
}

/**
 * Register the tools of servers the user asked to expose directly.
 *
 * Opt-in, and deliberately so: every directly registered tool sits in the
 * model's schema on every turn whether or not it is used, which is exactly the
 * cost the single `mcp` tool exists to avoid. Someone who turns this on for one
 * server has decided that server is worth it.
 *
 * This runs after activation because it has to connect to find out what the
 * tools are. Failing is not fatal — the `mcp` tool still reaches every server.
 */
async function registerDirectTools(pi: ExtensionAPI, manager: McpManager): Promise<void> {
  const listed = await manager.directTools();
  for (const { server, tool } of listed) {
    const name = directToolName(server, tool.name);
    pi.registerTool({
      name,
      label: `${server} · ${tool.name}`,
      description: tool.description ?? `${server} 提供的 ${tool.name} 工具。`,
      parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as never,
      async execute(_toolCallId, params) {
        try {
          const result = await manager.callTool(server, tool.name, (params ?? {}) as Record<string, unknown>);
          const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
          const text = Array.isArray(content)
            ? content.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n")
            : JSON.stringify(result);
          return textResult(text || "（服务器没有返回内容）", { server, tool: tool.name });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return textResult(message, { error: "call_failed", message, server, tool: tool.name }, true);
        }
      },
    });
  }
}

export default function coilcoilMcpTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "MCP",
    description:
      "访问已配置的 MCP Server。三步：action=\"list\" 看有哪些 Server（不联网，很快）→ action=\"tools\" 加 server 名字看它有哪些工具（这一步才会连接，可能要几秒）→ action=\"call\" 加 server、tool、args 调用。",
    promptSnippet: "mcp: 列出并调用 MCP Server 提供的工具",
    promptGuidelines: [
      "需要外部系统的能力时先 mcp list 看有哪些 Server；list 不联网所以很快，挑中一个之后再用 tools 去看它的工具，不要一上来就把所有 Server 都问一遍。",
    ],
    parameters: McpParams,

    async execute(_toolCallId, params) {
      const manager = requestMcpManager(pi.events);
      if (!manager) {
        return textResult("MCP 客户端当前不可用。", { error: "manager_unavailable" }, true);
      }

      if (params.action === "list") {
        const servers = await manager.listServers();
        return textResult(describeServers(servers), {
          servers: servers.map((entry) => entry.server),
          connected: servers.filter((entry) => entry.status === "connected").map((entry) => entry.server),
        });
      }

      const server = params.server?.trim();
      if (params.action === "tools") {
        if (!server) return textResult("tools 需要给出 server。", { error: "missing_target" }, true);
        try {
          const result = await manager.serverTools(server);
          return textResult(describeServerTools(server, result), {
            server,
            status: result.status,
            toolCount: result.tools.length,
          }, result.status !== "connected");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return textResult(message, { error: "tools_failed", message, server }, true);
        }
      }

      const tool = params.tool?.trim();
      if (!server || !tool) {
        return textResult("call 需要同时给出 server 和 tool。", { error: "missing_target" }, true);
      }
      try {
        const result = await manager.callTool(server, tool, (params.args ?? {}) as Record<string, unknown>);
        const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
        const text = Array.isArray(content)
          ? content.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n")
          : JSON.stringify(result);
        return textResult(text || "（服务器没有返回内容）", { server, tool });
      } catch (error) {
        // The server's own words, verbatim. "Invalid API key" tells the model
        // what to do next; "MCP call failed" does not.
        const message = error instanceof Error ? error.message : String(error);
        return textResult(message, { error: "call_failed", message, server, tool }, true);
      }
    },
  });

  const manager = requestMcpManager(pi.events);
  if (manager) {
    void registerDirectTools(pi, manager).catch(() => {
      // A server that will not come up must not take the `mcp` tool with it.
    });
  }
}
