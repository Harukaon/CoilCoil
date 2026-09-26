import assert from "node:assert/strict";
import test from "node:test";
import browserActExtension, { pageIdsForTabs, selectedPageId } from "../extensions/browser-act.ts";
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

test("browser-act 注册交互工具，描述里分清交互与调试；接管工具已经没有了", () => {
  const { tools } = collectTools();
  for (const name of ["browser_open", "browser_navigate", "browser_click", "browser_type", "browser_tabs"]) {
    assert.ok(tools.has(name), `缺少 ${name}`);
  }
  for (const name of ["browser_user_tabs", "browser_take_over"]) assert.equal(tools.has(name), false, `${name} 应该删掉了`);
  for (const [name, tool] of tools) assert.doesNotMatch(tool.description, /browser_take_over|browser_user_tabs/, `${name} 的描述里不该再让模型去调已经删掉的工具`);
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

// 下面几条按 chrome-devtools-mcp 的真实行为造假：出错是返回 isError，不是抛异常；
// new_page 的回执里带着页面列表，新页标着 [selected]。
type Call = { server: string; tool: string; args: Record<string, unknown> };
type Result = { content: Array<{ type: string; text?: string }>; details: Record<string, unknown>; isError: boolean };

function realisticTools(behavior: (tool: string, args: Record<string, unknown>) => unknown): { calls: Call[]; run: (name: string, params: Record<string, unknown>) => Promise<Result> } {
  const calls: Call[] = [];
  const tools = new Map<string, { execute: (id: string, params: never) => Promise<Result> }>();
  browserActExtension({
    events: {
      emit(channel: string, data: { manager?: unknown }) {
        if (channel !== MCP_MANAGER_CHANNEL) return;
        data.manager = {
          callTool: async (server: string, tool: string, args: Record<string, unknown>) => {
            calls.push({ server, tool, args });
            return behavior(tool, args);
          },
        };
      },
    },
    registerTool: (tool: never) => {
      const entry = tool as unknown as { name: string; execute: (id: string, params: never) => Promise<Result> };
      tools.set(entry.name, entry);
    },
  } as never);
  return { calls, run: (name, params) => tools.get(name)!.execute("t", params as never) };
}

const text = (value: string) => ({ content: [{ type: "text", text: value }] });

test("selectedPageId 认的是标着 [selected] 的那一页，不是第一行", () => {
  assert.equal(selectedPageId("## Pages\n1: page-a (http://a) \n2: page-b (http://b) [selected]"), 2);
  assert.equal(selectedPageId("## Pages\n1: page-a (http://a) [selected]\n2: page-b (http://b)"), 1);
  assert.equal(selectedPageId("没有页面"), undefined);
});

test("第二次 browser_open 的句柄绑在新开的那一页上，导航动的也是它", async () => {
  const { calls, run } = realisticTools((tool) => {
    if (tool === "new_page") return text("## Pages\n1: page-a (http://a)\n2: page-b (http://b) [selected]");
    return text(`${tool}-ok`);
  });
  const opened = await run("browser_open", { url: "http://b" });
  assert.equal(opened.details.pageId, 2, "句柄要绑新页，不能绑第一个标签页");
  await run("browser_navigate", { handle: opened.details.handle, url: "http://c" });
  const navigate = calls.find((call) => call.tool === "navigate_page");
  assert.equal(navigate?.args.pageId, 2);
});

test("MCP 返回 isError 时报失败，不报成功", async () => {
  const { run } = realisticTools((tool) => {
    if (tool === "click") return { ...text("Error: No snapshot found for page 1."), isError: true };
    if (tool === "navigate_page") return { ...text("Error: NAVIGATION_FAILED"), isError: true };
    return text("uid=2_0 RootWebArea");
  });
  const clicked = await run("browser_click", { uid: "9_9" });
  assert.equal(clicked.isError, true);
  assert.match(clicked.content[0]?.text ?? "", /点击失败/);
  assert.match(clicked.content[0]?.text ?? "", /uid=2_0/, "失败时要带回新快照");
  const navigated = await run("browser_navigate", { url: "http://nope" });
  assert.equal(navigated.isError, true);
  assert.match(navigated.content[0]?.text ?? "", /导航失败/);
});

test("句柄每个会话一份，两个会话的 btab-1 不会串", async () => {
  const first = realisticTools((tool) => (tool === "new_page" ? text("1: a [selected]") : text("ok")));
  const second = realisticTools((tool) => (tool === "new_page" ? text("1: x\n2: y [selected]") : text("ok")));
  const a = await first.run("browser_open", { url: "http://a" });
  const b = await second.run("browser_open", { url: "http://y" });
  assert.equal(a.details.handle, "btab-1");
  assert.equal(b.details.handle, "btab-1");
  await first.run("browser_navigate", { handle: "btab-1", url: "http://c" });
  assert.equal(first.calls.find((call) => call.tool === "navigate_page")?.args.pageId, 1);
});

test("浏览器报的标签页按标题和网址对到页面编号；同样的几张按先后一一对上", () => {
  const listing = "## Pages\n1: a (beta) (http://x/a.html) isolatedContext=isolated-context-1\n2: form (http://x/form.html)\n3:  (about:blank)\n4: form again (http://x/form.html) [selected] isolatedContext=isolated-context-1\n5:  (about:blank)";
  const ids = pageIdsForTabs(listing, [
    { title: "form again", url: "http://x/form.html" },
    { title: "a (beta)", url: "http://x/a.html" },
    { title: "about:blank", url: "about:blank" },
    { title: "about:blank", url: "about:blank" },
    { title: "form", url: "http://x/form.html" },
    { title: "gone", url: "http://x/none.html" },
  ]);
  assert.deepEqual(ids, [4, 1, 3, 5, 2, undefined]);
});

test("browser_tabs 列出这个对话的全部网页，给句柄、标出用户正看着的，同一页再列还是同一个句柄", async () => {
  const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
  let listPages = "1: mine (http://x/a.html) isolatedContext=isolated-context-1\n2: theirs (http://x/b.html) [selected] isolatedContext=isolated-context-1";
  let extraTab: Record<string, unknown> | undefined;
  const fake = fakePi(calls, (_server, tool) => tool === "list_pages"
    ? { content: [{ type: "text", text: listPages }] }
    : { content: [{ type: "text", text: "ok" }] });
  const tools = new Map<string, { execute: (id: string, params: never, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }> }>();
  browserActExtension({
    events: fake.events,
    registerTool: (tool: never) => {
      const entry = tool as unknown as { name: string; execute: (id: string, params: never, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }> };
      tools.set(entry.name, entry);
    },
  } as never);
  // 桌面端 CDP 桥上 CoilCoil 自己的接口：标签页列表，和每次调用后取一次的回收记录。
  const requested: string[] = [];
  const server = (await import("node:http")).createServer((request, response) => {
    requested.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify((request.url ?? "").startsWith("/coilcoil/tabs/") ? { tabs: [
      { id: "t1", title: "mine", url: "http://x/a.html", active: false, owner: "agent" },
      { id: "t2", title: "theirs", url: "http://x/b.html", active: true, owner: "user" },
      ...extraTab ? [extraTab] : [],
    ] } : { recycled: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const previous = process.env.COILCOIL_BROWSER_MCP_ARGS;
  process.env.COILCOIL_BROWSER_MCP_ARGS = JSON.stringify(["--wsEndpoint", `ws://127.0.0.1:${port}/devtools/browser/secret`, "--wsHeaders", JSON.stringify({ Authorization: "Bearer token" })]);
  const ctx = { sessionManager: { getSessionId: () => "session-1" } };
  try {
    const tabs = tools.get("browser_tabs")! as unknown as { execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }> };
    const first = await tabs.execute("1", {}, undefined, undefined, ctx);
    const text = first.content[0].text ?? "";
    assert.match(text, /btab-1（你开的）：mine/, text);
    assert.match(text, /btab-2（用户正看着）（用户开的）：theirs/, text);
    assert.ok(requested.some((url) => url.startsWith("/coilcoil/tabs/secret?scope=session-1")), requested.join(","));
    const again = await tabs.execute("2", {}, undefined, undefined, ctx);
    assert.equal(again.content[0].text, text, "同一张页面再列一次还是原来的句柄");
    // 浏览器里有、页面列表里还没出现的那张：不给句柄，免得句柄落到别的页上。
    listPages = "1: mine (http://x/a.html)\n2: theirs (http://x/b.html) [selected]";
    extraTab = { id: "t3", title: "fresh", url: "http://x/fresh.html", active: false, owner: "agent" };
    const pending = await tabs.execute("3", {}, undefined, undefined, ctx);
    assert.match(pending.content[0].text ?? "", /还拿不到句柄[^\n]*fresh/, pending.content[0].text);
    assert.doesNotMatch(pending.content[0].text ?? "", /btab-3/);
    extraTab = undefined;
    const click = tools.get("browser_click")! as unknown as { execute: (...args: unknown[]) => Promise<unknown> };
    await click.execute("3", { handle: "btab-2", uid: "1_1" }, undefined, undefined, ctx);
    assert.equal(calls.find((call) => call.tool === "click")?.args.pageId, 2, "用户那张页面拿句柄就能直接点");
  } finally {
    server.close();
    if (previous === undefined) delete process.env.COILCOIL_BROWSER_MCP_ARGS; else process.env.COILCOIL_BROWSER_MCP_ARGS = previous;
  }
});

test("点击让网页弹出对话框时，如实说「已生效、先处理对话框」，不当成点击失败", async () => {
  const { pendingDialogNotice } = await import("../extensions/browser-act.ts");
  const raw = "# Open dialog\nalert: hello from page. Call handle_dialog to handle it before continuing.\nError: Failed to interact with the element with uid 1_2.";
  const notice = pendingDialogNotice(raw);
  assert.ok(notice?.includes("alert"), notice);
  assert.ok(notice?.includes("「hello from page」"), notice);
  assert.ok(notice?.includes("handle_dialog"), notice);
  assert.equal(pendingDialogNotice("Error: element not found"), undefined);
});
