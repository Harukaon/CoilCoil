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

test("browser-act 工具名与描述锁死：描述里提到的工具必须真实存在", async () => {
  // 防模型猜名：描述里写的每一个工具名，必须是本文件或 coilcoil-browser 真实提供的。
  const { tools } = collectTools();
  const known = new Set([
    ...tools.keys(),
    // coilcoil-browser 调试层（chrome-devtools-mcp 1.7.0 实际提供）：
    "list_pages", "new_page", "select_page", "close_page", "navigate_page",
    "take_snapshot", "take_screenshot", "click", "fill", "type_text",
    "press_key", "wait_for", "evaluate_script",
    "list_console_messages", "get_console_message",
    "list_network_requests", "get_network_request",
    "performance_start_trace", "performance_stop_trace",
    "lighthouse_audit",
  ]);
  const mentioned = new Set<string>();
  for (const tool of tools.values()) {
    for (const match of tool.description.matchAll(/`?([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`?/g)) {
      mentioned.add(match[1]);
    }
  }
  const unknown = [...mentioned].filter((name) => !known.has(name));
  assert.deepEqual(unknown, [], `描述里提到了不存在的工具：${unknown.join(", ")}`);
});
