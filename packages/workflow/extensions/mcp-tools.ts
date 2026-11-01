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
import { convertMcpResult, type ExtensionAPI, type ExtensionContext, limitMcpContent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { McpManager } from "@coilcoil/mcp";
import { BROWSER_MCP_SERVER } from "./browser-bridge.ts";
import { MCP_TOOLS_REFRESH_ENTRY, MCP_TOOLS_SNAPSHOT_ENTRY } from "./mcp-session-state.ts";
export { MCP_TOOLS_REFRESH_ENTRY, MCP_TOOLS_SNAPSHOT_ENTRY } from "./mcp-session-state.ts";

const TOOL_NAME = "mcp";
export const MCP_MANAGER_CHANNEL = "coilcoil:mcp:manager:v1";
type DirectTool = Awaited<ReturnType<McpManager["directTools"]>>[number];
interface DirectSnapshot { tools: DirectTool[]; activeNames?: string[] }

function restoredDirectTools(ctx: ExtensionContext): DirectSnapshot | undefined {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "custom") continue;
    if (entry.customType === MCP_TOOLS_REFRESH_ENTRY) return undefined;
    if (entry.customType !== MCP_TOOLS_SNAPSHOT_ENTRY) continue;
    const value = entry.data as { version?: unknown; sessionId?: unknown; tools?: unknown; activeNames?: unknown } | undefined;
    if (value?.version !== 1 || value.sessionId !== ctx.sessionManager.getSessionId() || !Array.isArray(value.tools)) continue;
    if (!value.tools.every((entry) => entry && typeof entry.server === "string" && entry.tool
      && typeof entry.tool.name === "string" && (entry.tool.description === undefined || typeof entry.tool.description === "string")
      && (entry.tool.inputSchema === undefined || (typeof entry.tool.inputSchema === "object" && entry.tool.inputSchema !== null)))) continue;
    if (value.activeNames !== undefined && (!Array.isArray(value.activeNames) || !value.activeNames.every((name) => typeof name === "string"))) continue;
    return { tools: structuredClone(value.tools) as DirectTool[], activeNames: value.activeNames as string[] | undefined };
  }
  return undefined;
}

function sortedDirectTools(tools: DirectTool[]): DirectTool[] {
  return structuredClone(tools).sort((left, right) => {
    const a = `${left.server}\0${left.tool.name}`;
    const b = `${right.server}\0${right.tool.name}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

const McpParams = Type.Object({
  action: StringEnum(["list", "tools", "call"], {
    description: "list: list the MCP servers (no network, fast); tools: connect to one server and list its tools; call: call one tool",
  }),
  server: Type.Optional(Type.String({ description: "Required for tools and call: the MCP server name" })),
  tool: Type.Optional(Type.String({ description: "Required for call: the tool name" })),
  args: Type.Optional(Type.Object({}, {
    additionalProperties: true,
    description: "Argument object passed to the tool on call; omit it when the tool takes no arguments",
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

async function textResult(text: string, details: Record<string, unknown>, isError = false) {
  // Use Pi's MCP budget for both dispatch paths, including single-line JSON.
  // Full output is saved privately and the model gets a path for bounded reads.
  const { content, fullOutputPath } = await limitMcpContent([{ type: "text", text }]);
  return { content, details: { ...details, ...(fullOutputPath ? { fullOutputPath } : {}) }, isError };
}

async function toolResult(server: string, tool: string, result: unknown, notice = "") {
  const raw = result as Parameters<typeof convertMcpResult>[2];
  const content = Array.isArray(raw?.content)
    ? raw.content.slice()
    : [{ type: "text" as const, text: JSON.stringify(result) ?? "（服务器没有返回内容）" }];
  if (notice) content.push({ type: "text", text: notice });
  // Pi handles images, embedded resources, structured-only results and the text budget together.
  const converted = await convertMcpResult(server, tool, { ...raw, content });
  if (!converted.content.length) converted.content.push({ type: "text", text: "（服务器没有返回内容）" });
  return { ...converted, isError: raw?.isError === true };
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
    // Only the count. Naming every tool of a connected server sounds harmless
    // until one of them offers thirty — and then every `list` pays for thirty
    // names nobody asked for. Asking a connected server for its tools costs no
    // network at all, so the names are one cheap step away.
    if (entry.status === "connected") return `- ${entry.server}（已连接，${entry.tools.length} 个工具）`;
    if (entry.status === "needs-auth") return `- ${entry.server}（需要先在设置里完成认证）`;
    if (entry.status === "failed") return `- ${entry.server}（上次连接失败）`;
    return `- ${entry.server}（未连接，用 action="tools" 查看它有哪些工具）`;
  });
  return [
    "已配置的 MCP Server：",
    ...lines,
    "",
    "这一步没有联网，也没有列出具体工具名。要看某个 Server 有哪些工具，用 action=\"tools\" 加 server 名字；已连接的服务器问一下不花任何代价，没连的那一步才会真的去连它、可能要几秒。",
  ].join("\n");
}

/** One server's tools, once the model has decided it wants that one. */
export function describeServerTools(server: string, result: {
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
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
    ...result.tools.map((tool) => [
      `  - ${tool.name}${tool.description ? `：${tool.description}` : ""}`,
      tool.inputSchema ? `    inputSchema: ${JSON.stringify(tool.inputSchema)}` : "",
    ].filter(Boolean).join("\n")),
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
function registerDirectTools(pi: ExtensionAPI, manager: McpManager, listed: DirectTool[]): void {
  for (const { server, tool } of listed) {
    const name = directToolName(server, tool.name);
    pi.registerTool({
      name,
      label: `${server} · ${tool.name}`,
      description: tool.description ?? `The ${tool.name} tool provided by ${server}.`,
      parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as never,
      // signal 是 pi 给工具的中断信号。不接它，界面上的停止按钮就按不停一次 MCP
      // 调用：pi 那边早就放手了，这条请求还在跑，人只能干等它自己结束。
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        try {
          const result = await manager.callTool(server, tool.name, (params ?? {}) as Record<string, unknown>, signal,
            { toolCallId, sessionId: ctx.sessionManager.getSessionId(), sessionPath: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd });
          return toolResult(server, tool.name, result);
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
    description: [
      "Access the configured MCP servers in three steps: action=\"list\" shows which servers exist (no network, fast); action=\"tools\" with a server name shows that server's tools and their input schemas (this connects, which can take a few seconds); action=\"call\" with server, tool and args matching that tool's input schema runs a tool.",
      "When you need a capability from an external system, start with list; once you have picked a server, use tools on it. Do not query every server up front.",
      "Use the browser tool for the built-in browser, including browser debugging operations.",
    ].join(" "),
    parameters: McpParams,

    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const manager = requestMcpManager(pi.events);
      if (!manager) {
        return textResult("MCP 客户端当前不可用。", { error: "manager_unavailable" }, true);
      }

      if (params.action === "list") {
        const servers = (await manager.listServers()).filter((entry) => entry.server !== BROWSER_MCP_SERVER);
        return textResult(describeServers(servers), {
          servers: servers.map((entry) => entry.server),
          connected: servers.filter((entry) => entry.status === "connected").map((entry) => entry.server),
        });
      }

      const server = params.server?.trim();
      if (server === BROWSER_MCP_SERVER) {
        return textResult("内置浏览器已统一到 browser 工具，请用它的 list、tools、call 按需查询和调用；未提供 browser 的 Agent 不能使用内置浏览器。", { error: "use_browser" }, true);
      }
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
        const result = await manager.callTool(server, tool, (params.args ?? {}) as Record<string, unknown>, signal,
          { toolCallId, sessionId: ctx.sessionManager.getSessionId(), sessionPath: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd });
        // 工具报错是返回 isError，不是抛异常；照实标成失败，界面和模型才不会当它成功了。
        return toolResult(server, tool, result);
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
    let current = true;
    let prefixStarted = false;
    let saved = false;
    let generation = 0;
    let listed: DirectTool[] = [];
    const registeredNames = new Set<string>();
    const replace = (next: DirectTool[], activeNames?: string[]): void => {
      const ordinary = pi.getActiveTools().filter((name) => !registeredNames.has(name)
        && !name.startsWith("mcp__coilcoil_browser__"));
      listed = next.filter((entry) => entry.server !== BROWSER_MCP_SERVER);
      registerDirectTools(pi, manager, listed);
      const names = listed.map(({ server, tool }) => directToolName(server, tool.name));
      for (const name of names) registeredNames.add(name);
      pi.setActiveTools([...new Set([...ordinary, ...(activeNames ?? names).filter((name) => names.includes(name))])]);
    };
    const restore = (_event: unknown, ctx: ExtensionContext): void => {
      current = true;
      const epoch = ++generation;
      const snapshot = restoredDirectTools(ctx);
      saved = snapshot !== undefined;
      prefixStarted = saved;
      replace(snapshot?.tools ?? [], snapshot?.activeNames);
      if (saved) return;
      void manager.directTools().then((tools) => {
        if (current && !prefixStarted && generation === epoch) replace(sortedDirectTools(tools));
      }).catch(() => {
        // A server that will not come up must not take the `mcp` tool with it.
      });
    };
    pi.on("session_start", restore);
    pi.on("session_tree", restore);
    // Do not stall the first turn for network discovery. Definitions that arrive
    // after its prefix is fixed wait for an explicit refresh; the generic MCP tool still works.
    pi.on("before_agent_start", (_event, ctx) => {
      prefixStarted = true;
      if (saved) return;
      pi.appendEntry(MCP_TOOLS_SNAPSHOT_ENTRY, {
        version: 1, sessionId: ctx.sessionManager.getSessionId(), tools: structuredClone(listed),
        activeNames: pi.getActiveTools().filter((name) => registeredNames.has(name)),
      });
      saved = true;
    });
    pi.on("session_shutdown", () => { current = false; generation += 1; });
  }
}
