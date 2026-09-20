import assert from "node:assert/strict";
import test from "node:test";
import browserActExtension from "../extensions/browser-act.ts";
import { MCP_MANAGER_CHANNEL } from "../extensions/mcp-tools.ts";

function fakePi(calls: Array<{ server: string; tool: string; args: Record<string, unknown> }>, behavior?: (server: string, tool: string) => unknown): {
  events: { emit(channel: string, data: { manager?: unknown }): void };
  registered: Array<{ name: string; description: string }>;
} {
  const registered: Array<{ name: string; description: string }> = [];
  return {
    registered,
    events: {
      emit(channel: string, data: { manager?: unknown }) {
        if (channel !== MCP_MANAGER_CHANNEL) return;
        data.manager = {
          callTool: async (server: string, tool: string, args: Record<string, unknown>) => {
            calls.push({ server, tool, args });
            if (behavior) return behavior(server, tool);
            if (tool === "list_pages") return { content: [{ type: "text", text: "1: about:blank" }] };
            if (tool === "take_snapshot") return { content: [{ type: "text", text: "snapshot-ok" }] };
            return { content: [{ type: "text", text: `${tool}-ok` }] };
          },
        };
      },
    },
  };
}

function collectTools(): { tools: Map<string, { description: string; execute: (id: string, params: never, signal?: AbortSignal) => Promise<unknown> }>; pi: { registerTool(t: never): void; events: { emit(): void } } } {
  const tools = new Map<string, { description: string; execute: (id: string, params: never, signal?: AbortSignal) => Promise<unknown> }>();
  const fake = fakePi([]);
  const pi = {
    events: fake.events,
    registerTool: (tool: { name: string; description: string; execute: (id: string, params: never, signal?: AbortSignal) => Promise<unknown> }) => {
      tools.set(tool.name, tool);
    },
  };
  browserActExtension(pi as never);
  return { tools, pi };
}

test("browser-act 注册四个交互工具，描述里分清交互与调试", () => {
  const { tools } = collectTools();
  for (const name of ["browser_open", "browser_navigate", "browser_click", "browser_type"]) {
    assert.ok(tools.has(name), `缺少 ${name}`);
  }
  const open = tools.get("browser_open")!;
  assert.match(open.description, /coilcoil-browser/, "browser_open 描述要指明调试继续用 coilcoil-browser");
});

test("browser_open 返回句柄，后续操作可拿句柄", async () => {
  const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
  const fake = fakePi(calls);
  const tools = new Map<string, { execute: (id: string, params: never, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }> }>();
  const pi = {
    events: fake.events,
    registerTool: (tool: never) => {
      const entry = tool as unknown as { name: string; execute: (id: string, params: never, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }> };
      tools.set(entry.name, entry);
    },
  };
  browserActExtension(pi as never);
  const opened = await tools.get("browser_open")!.execute("t1", { url: "https://example.com" } as never);
  const handle = (opened.details as { handle: string }).handle;
  assert.match(handle, /^btab-\d+$/, "句柄格式");
  assert.match(opened.content[0]?.text ?? "", /已打开/, "打开回执");
});

test("browser_click 失败时带回新快照而不是吞错", async () => {
  const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
  const fake = fakePi(calls, (server, tool) => {
    if (tool === "click") throw new Error("Element not found");
    return { content: [{ type: "text", text: "fresh-snapshot" }] };
  });
  const tools = new Map<string, { execute: (id: string, params: never, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown>; isError: boolean }> }>();
  const pi = {
    events: fake.events,
    registerTool: (tool: never) => {
      const entry = tool as unknown as { name: string; execute: (id: string, params: never, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown>; isError: boolean }> };
      tools.set(entry.name, entry);
    },
  };
  browserActExtension(pi as never);
  const result = await tools.get("browser_click")!.execute("t1", { uid: "stale-uid" } as never);
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /已重取快照/, "失败要带回新快照");
  assert.match(result.content[0]?.text ?? "", /fresh-snapshot/, "新快照内容要交出去");
});
