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
  action: StringEnum(["list", "call"], {
    description: "list：列出可用的 MCP Server 和它们的工具；call：调用其中一个工具",
  }),
  server: Type.Optional(Type.String({ description: "call 时必填：MCP Server 名称" })),
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
export function describeTools(listed: Array<{ server: string; tool: { name: string; description?: string } }>): string {
  if (!listed.length) return "当前没有可用的 MCP 工具。可能是还没配置服务器，或者配置的服务器都已停用。";
  const byServer = new Map<string, string[]>();
  for (const { server, tool } of listed) {
    const lines = byServer.get(server) ?? [];
    lines.push(`  - ${tool.name}${tool.description ? `：${tool.description}` : ""}`);
    byServer.set(server, lines);
  }
  return [...byServer].map(([server, lines]) => `${server}\n${lines.join("\n")}`).join("\n\n");
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
      "访问已配置的 MCP Server。先用 action=\"list\" 看有哪些服务器和工具，再用 action=\"call\" 加上 server、tool 和 args 调用。服务器按需连接，第一次调用可能稍慢。",
    promptSnippet: "mcp: 列出并调用 MCP Server 提供的工具",
    promptGuidelines: [
      "需要外部系统的能力时先 mcp list 看有什么，不要凭猜测直接 call。",
    ],
    parameters: McpParams,

    async execute(_toolCallId, params) {
      const manager = requestMcpManager(pi.events);
      if (!manager) {
        return textResult("MCP 客户端当前不可用。", { error: "manager_unavailable" }, true);
      }

      if (params.action === "list") {
        const listed = await manager.listTools();
        return textResult(describeTools(listed), {
          servers: [...new Set(listed.map((entry) => entry.server))],
          toolCount: listed.length,
        });
      }

      const server = params.server?.trim();
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
