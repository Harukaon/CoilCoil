import { StringEnum, validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { convertMcpResult, limitMcpContent, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestMcpManager } from "./mcp-tools.ts";
import { BROWSER_MCP_SERVER, drainBrowserNotice, noteBrowserCall } from "./browser-recycle-notice.ts";

export type BrowserAction = Pick<ToolDefinition, "name" | "description" | "parameters" | "execute">;

async function result(value: unknown, details: Record<string, unknown> = {}, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const limited = await limitMcpContent([{ type: "text", text }]);
  return { content: limited.content, details: { ...details, ...(limited.fullOutputPath ? { fullOutputPath: limited.fullOutputPath } : {}) }, isError };
}

/** Only this compact schema enters the model's tool list; operation schemas are returned on demand. */
export function registerBrowserGateway(pi: ExtensionAPI, actions: ReadonlyMap<string, BrowserAction>): void {
  pi.registerTool({
    name: "browser",
    label: "Browser",
    description: "Use the built-in browser through this single entry point. action=list shows common browsing actions without connecting; action=tools lists all available operations, or shows one operation's input schema when tool is supplied; action=call runs tool with args. Discover a schema before calling it. Common operations are open, navigate, click, type and tabs; additional debugging operations use the devtools. prefix. Use tabs to identify the user's page, and change user-opened pages only when requested.",
    parameters: Type.Object({
      action: StringEnum(["list", "tools", "call"] as const),
      tool: Type.Optional(Type.String({ description: "Operation name from list/tools; required for call" })),
      args: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Arguments matching the selected operation's input schema" })),
    }, { additionalProperties: false }),
    async execute(id, params, signal, onUpdate, ctx) {
      try {
        signal?.throwIfAborted();
        const tool = params.tool?.trim();
        const action = tool ? actions.get(tool) : undefined;
        if (params.action === "list") return result({
          operations: [...actions.values()].map(({ name, description }) => ({ name, description })),
          next: "Use action=tools with tool to get one schema, or omit tool to discover debugging operations.",
        });
        if (params.action === "call" && !tool) return result("call requires tool.", { error: "missing_target" }, true);
        if (action) {
          if (params.action === "tools") return result({ name: action.name, description: action.description, inputSchema: action.parameters });
          const args = validateToolArguments(action, { type: "toolCall", id, name: action.name, arguments: (params.args ?? {}) as ToolCall["arguments"] });
          return await action.execute(id, args, signal, onUpdate, ctx);
        }
        if (tool && !tool.startsWith("devtools.")) return result("Unknown browser operation. Use action=list or action=tools to discover operations.", { error: "unknown_tool", tool }, true);
        const manager = requestMcpManager(pi.events);
        if (!manager) return result("内置浏览器客户端当前不可用。", { error: "manager_unavailable" }, true);
        const available = await manager.serverTools(BROWSER_MCP_SERVER);
        signal?.throwIfAborted();
        if (available.status !== "connected") return result(available.failure ?? "内置浏览器当前不可用，请打开桌面浏览器后重试。", { status: available.status }, true);
        if (!tool) return result({ operations: [
          ...[...actions.values()].map(({ name, description }) => ({ name, description })),
          ...available.tools.map(({ name, description }) => ({ name: `devtools.${name}`, description })),
        ], next: "Use action=tools with one tool name for its input schema." });
        const rawName = tool.slice("devtools.".length);
        const definition = available.tools.find((entry) => entry.name === rawName);
        if (!definition) return result("Unknown browser operation. Use action=tools to discover operations.", { error: "unknown_tool", tool }, true);
        const schema = definition.inputSchema ?? { type: "object", properties: {} };
        if (params.action === "tools") return result({ name: tool, description: definition.description, inputSchema: schema });
        const args = validateToolArguments({ name: tool, description: definition.description ?? "", parameters: schema as never },
          { type: "toolCall", id, name: tool, arguments: (params.args ?? {}) as ToolCall["arguments"] });
        const raw = await manager.callTool(BROWSER_MCP_SERVER, rawName, args, signal) as Parameters<typeof convertMcpResult>[2];
        const session = ctx?.sessionManager?.getSessionId();
        const text = (raw.content ?? []).flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
        await noteBrowserCall(session, text);
        const notice = drainBrowserNotice(session);
        const converted = await convertMcpResult(BROWSER_MCP_SERVER, rawName, { ...raw, content: raw.content ?? [] });
        if (notice) converted.content.push({ type: "text", text: notice });
        return { ...converted, isError: raw.isError === true };
      } catch (error) {
        signal?.throwIfAborted();
        return result(error instanceof Error ? error.message : String(error), { error: "browser_failed" }, true);
      }
    },
  });
}
