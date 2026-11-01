import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import coilcoilMcpTools, {
  MCP_MANAGER_CHANNEL,
  MCP_TOOLS_REFRESH_ENTRY,
  MCP_TOOLS_SNAPSHOT_ENTRY,
  describeServerTools,
  describeServers,
  directToolName,
  requestMcpManager,
} from "../extensions/mcp-tools.ts";

test("向运行时要 MCP 客户端，拿到的是同一个对象", () => {
  // 不是复制一份配置自己再连一遍——Agent 和设置界面共用同一套连接和同一份凭据。
  const bus = createEventBus();
  const manager = { marker: "runtime" };
  bus.on(MCP_MANAGER_CHANNEL, (data) => { (data as { manager?: unknown }).manager = manager; });
  assert.equal(requestMcpManager(bus as never), manager as never);
});

test("没人应答就是没有，不去猜也不去自己造一个", () => {
  const bus = createEventBus();
  assert.equal(requestMcpManager(bus as never), undefined);
});

test("总线抛错也不能把工具本身弄崩", () => {
  const events = { emit: () => { throw new Error("bus is gone"); } };
  assert.equal(requestMcpManager(events), undefined);
});

test("列 Server 这一步明说自己没联网，并指路下一步", () => {
  // 慢的根子就是「看看有什么」把每个服务器都连一遍。现在这一步是免费的，
  // 但必须告诉模型：想知道具体工具，得再走一步，而那一步要等几秒。
  const rendered = describeServers([
    { server: "firecrawl", status: "not connected", tools: [] },
    { server: "beeswax", status: "needs-auth", tools: [] },
    { server: "local", status: "connected", tools: [{ name: "echo" }, { name: "read" }] },
  ]);
  assert.match(rendered, /没有联网/);
  assert.match(rendered, /- firecrawl（未连接/);
  assert.match(rendered, /- beeswax（需要先在设置里完成认证）/);
  // 只报数量，不报名字：一个服务器三十个工具的时候，每次 list 都要为三十个
  // 没人要的名字买单；而向已连接的服务器要工具清单是不花钱的。
  assert.match(rendered, /- local（已连接，2 个工具）/);
  assert.doesNotMatch(rendered, /echo/);
  assert.match(rendered, /action="tools"/);
});

test("一个 Server 都没有的时候说清楚可能是为什么", () => {
  const rendered = describeServers([]);
  assert.match(rendered, /没有可用的 MCP Server/);
  assert.match(rendered, /还没配置|已停用/);
});

test("某个 Server 的工具清单带描述", () => {
  const rendered = describeServerTools("github", {
    status: "connected",
    tools: [{ name: "search", description: "搜索仓库" }, { name: "read" }],
  });
  assert.match(rendered, /github 提供的工具/);
  assert.match(rendered, /- search：搜索仓库/);
  assert.match(rendered, /- read$/m);
});

test("连不上就把服务器自己那句话的第一行带出来", () => {
  // 「连接失败」打发不了模型；「Invalid API key」它才知道下一步该干嘛。
  const rendered = describeServerTools("local", {
    status: "failed",
    tools: [],
    failure: "spawn ENOENT\n一堆栈信息",
  });
  assert.match(rendered, /local 连不上：spawn ENOENT/);
  assert.doesNotMatch(rendered, /栈信息/);
});

test("需要认证和已停用各有各的说法", () => {
  assert.match(describeServerTools("a", { status: "needs-auth", tools: [] }), /需要先在设置里完成认证/);
  assert.match(describeServerTools("a", { status: "disabled", tools: [] }), /已停用/);
  assert.match(describeServerTools("a", { status: "connected", tools: [] }), /没有提供任何工具/);
});

test("直接注册的工具名字带着服务器，横杠换成下划线", () => {
  // `mcp__` 这个前缀是 CoilCoil 其他地方（上下文统计）认 MCP 工具的依据。
  assert.equal(directToolName("github", "search"), "mcp__github__search");
  assert.equal(directToolName("my-server", "read"), "mcp__my_server__read");
});

test("MCP 工具报错（返回 isError）时，mcp 工具如实标成失败", async () => {
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ isError: boolean; content: Array<{ text: string }> }> }>();
  const manager = {
    callTool: async () => ({ content: [{ type: "text", text: "Error: No page found" }], isError: true }),
    directTools: async () => [],
  };
  coilcoilMcpTools({
    on: () => () => undefined,
    events: { emit: (channel: string, data: { manager?: unknown }) => { if (channel === MCP_MANAGER_CHANNEL) data.manager = manager; } },
    registerTool: (tool: never) => { const entry = tool as { name: string; execute: never }; tools.set(entry.name, entry); },
  } as never);
  const result = await tools.get("mcp")!.execute("t", { action: "call", server: "some-server", tool: "x" }, undefined, undefined,
    { cwd: "/project", sessionManager: { getSessionId: () => "session-a", getSessionFile: () => "/sessions/a.jsonl" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No page found/);
});

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  details: Record<string, unknown>;
  isError: boolean;
};

type SavedEntry = { type: "custom"; customType: string; data: unknown };
function lifecycle(manager: unknown, entries: SavedEntry[] = [], sessionId = "session-a") {
  const ctx = { cwd: "/project", sessionManager: { getBranch: () => entries, getSessionId: () => sessionId, getSessionFile: () => `/sessions/${sessionId}.jsonl` } };
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools = new Map<string, { name: string; description: string; parameters: unknown;
    execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult> }>();
  let active: string[] = [];
  coilcoilMcpTools({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); },
    events: { emit: (name: string, data: { manager?: unknown }) => { if (name === MCP_MANAGER_CHANNEL) data.manager = manager; } },
    registerTool: (tool: never) => { const entry = tool as { name: string; description: string; parameters: unknown; execute: (...args: unknown[]) => Promise<ToolResult> };
      tools.set(entry.name, { ...entry, execute: (id, params) => entry.execute(id, params, undefined, undefined, ctx) }); if (!active.includes(entry.name)) active.push(entry.name); },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
    appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
  } as never);
  return { tools, entries, active: () => [...active], emit: (name: string) => handlers.get(name)?.({}, ctx) };
}

async function registerMcpResult(result: unknown) {
  const manager = {
    callTool: async () => result,
    directTools: async () => [{ server: "test-server", tool: { name: "query" } }],
  };
  const harness = lifecycle(manager);
  harness.emit("session_start");
  // Direct tools register after the runtime's asynchronous discovery.
  await Promise.resolve();
  return (direct = false) => harness.tools.get(direct ? "mcp__test_server__query" : "mcp")!.execute("t", {
    action: "call", server: "test-server", tool: "query",
  });
}

test("the built-in browser is absent from MCP discovery and restored direct tools", async () => {
  let calls = 0;
  const tools = [
    { server: "coilcoil-browser", tool: { name: "list_pages", inputSchema: { type: "object", properties: {} } } },
    { server: "github", tool: { name: "search", inputSchema: { type: "object", properties: {} } } },
  ];
  const manager = {
    directTools: async () => tools,
    listServers: async () => tools.map(({ server, tool }) => ({ server, status: "connected", tools: [tool] })),
    callTool: async () => { calls++; return {}; },
    serverTools: async () => { calls++; return { status: "connected", tools: [] }; },
  };
  const h = lifecycle(manager, [{ type: "custom", customType: MCP_TOOLS_SNAPSHOT_ENTRY,
    data: { version: 1, sessionId: "session-a", tools, activeNames: tools.map(({ server, tool }) => directToolName(server, tool.name)) } }]);
  h.emit("session_start");
  assert.ok(h.active().includes("mcp__github__search"));
  assert.ok(!h.active().some((name) => name.startsWith("mcp__coilcoil_browser__")));
  assert.ok(!h.tools.has("mcp__coilcoil_browser__list_pages"));
  const mcp = h.tools.get("mcp")!;
  const listed = await mcp.execute("list", { action: "list" });
  assert.doesNotMatch(listed.content[0].text!, /coilcoil-browser/);
  for (const action of ["tools", "call"]) {
    const denied = await mcp.execute(action, { action, server: "coilcoil-browser", tool: "list_pages" });
    assert.equal(denied.isError, true);
    assert.equal(denied.details.error, "use_browser");
  }
  assert.equal(calls, 0);
});

const MCP_TEXT_LIMIT = 20 * 1024;

for (const direct of [false, true]) {
  test(`${direct ? "直接注册" : "mcp 调用"}的超大单行结果截断入模，完整原文仍可读取`, async (context) => {
    // Regression: two 1,491,600-character query results overflowed the live context.
    const original = `BEGIN${"x".repeat(1_491_592)}END`;
    const run = await registerMcpResult({ content: [{ type: "text", text: original }] });
    const result = await run(direct);
    const text = result.content.map((part) => part.text ?? "").join("\n");
    assert.ok(Buffer.byteLength(text) < MCP_TEXT_LIMIT + 1024, "model-facing output must stay bounded");
    assert.match(text, /BEGIN/);
    assert.match(text, /END/);
    assert.match(text, /truncated/);
    assert.equal(result.isError, false);
    assert.equal(result.details.server, "test-server");
    assert.equal(result.details.tool, "query");
    const fullOutputPath = result.details.fullOutputPath;
    assert.equal(typeof fullOutputPath, "string");
    context.after(() => rm(fullOutputPath as string, { force: true }));
    assert.ok(text.includes(fullOutputPath as string), "the model needs the path to read the full result");
    assert.match(text, /offset\/limit/);
    assert.equal(await readFile(fullOutputPath as string, "utf8"), original);
    if (process.platform !== "win32") assert.equal((await stat(fullOutputPath as string)).mode & 0o777, 0o600);
  });
}

test("MCP 返回刚好 20KB 时保持原样", async () => {
  const original = "x".repeat(MCP_TEXT_LIMIT);
  const run = await registerMcpResult({ content: [{ type: "text", text: original }] });
  const result = await run();
  assert.equal(result.content[0].text, original);
  assert.equal(result.details.fullOutputPath, undefined);
});

test("首轮不等待 MCP 网络；迟到或已关闭的发现不能回填会话工具", async () => {
  for (const mode of ["ready", "late", "shutdown"] as const) {
    let release!: (tools: unknown[]) => void;
    const pending = new Promise<unknown[]>((resolve) => { release = resolve; });
    const harness = lifecycle({ directTools: () => pending });
    harness.emit("session_start");
    assert.deepEqual(harness.active(), ["mcp"]);
    if (mode === "late") assert.equal(harness.emit("before_agent_start"), undefined, "the turn must proceed without waiting for discovery");
    if (mode === "shutdown") harness.emit("session_shutdown");
    release([{ server: "local", tool: { name: "query", description: "Query" } }]);
    await pending;
    await Promise.resolve();
    if (mode === "ready") harness.emit("before_agent_start");
    assert.deepEqual(harness.active(), mode === "ready" ? ["mcp", "mcp__local__query"] : ["mcp"]);
  }
});

test("MCP direct schemas and order survive resume; an explicit user refresh adopts the new schemas", async () => {
  const original = [
    { server: "z", tool: { name: "query", description: "Original query", inputSchema: { type: "object", required: ["filter"],
      properties: { filter: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } } } } },
    { server: "a", tool: { name: "read", description: "Original read", inputSchema: { type: "object", properties: {} } } },
  ];
  let discoveryCalls = 0;
  let available = original;
  const manager = { directTools: async () => { discoveryCalls++; return available; } };
  const first = lifecycle(manager);
  first.emit("session_start");
  await Promise.resolve();
  first.emit("before_agent_start");
  assert.deepEqual(first.active(), ["mcp", "mcp__a__read", "mcp__z__query"]);
  const schema = structuredClone(first.tools.get("mcp__z__query")!.parameters);
  first.emit("session_shutdown");
  available = [{ ...original[0], tool: { ...original[0].tool, description: "Changed query", inputSchema: { type: "object", properties: {} } } }];
  const resumed = lifecycle(manager, first.entries);
  resumed.emit("session_start");
  await Promise.resolve();
  assert.equal(discoveryCalls, 1, "resume must replay persisted definitions without discovering a changed schema");
  assert.deepEqual(resumed.active(), first.active());
  assert.equal(resumed.tools.get("mcp__z__query")!.description, "Original query");
  assert.deepEqual(resumed.tools.get("mcp__z__query")!.parameters, schema);
  resumed.emit("before_agent_start");
  assert.equal(first.entries.filter((entry) => entry.customType === MCP_TOOLS_SNAPSHOT_ENTRY).length, 1);

  first.entries.push({ type: "custom", customType: MCP_TOOLS_REFRESH_ENTRY, data: { version: 1 } });
  resumed.emit("session_tree");
  await Promise.resolve();
  resumed.emit("before_agent_start");
  assert.equal(discoveryCalls, 2);
  assert.deepEqual(resumed.active(), ["mcp", "mcp__z__query"]);
  assert.equal(resumed.tools.get("mcp__z__query")!.description, "Changed query");
  assert.deepEqual(resumed.tools.get("mcp__z__query")!.parameters, available[0].tool.inputSchema);
});

test("an empty first-turn direct tool snapshot remains empty on resume and a prior branch's discovery is discarded", async () => {
  let release!: (value: unknown[]) => void;
  const pending = new Promise<unknown[]>((resolve) => { release = resolve; });
  const first = lifecycle({ directTools: () => pending });
  first.emit("session_start");
  first.emit("before_agent_start");
  const restored = lifecycle({ directTools: async () => { throw new Error("must not discover on resume"); } }, first.entries);
  restored.emit("session_start");
  assert.deepEqual(restored.active(), ["mcp"]);
  first.emit("session_tree");
  release([{ server: "late", tool: { name: "tool" } }]);
  await pending;
  await Promise.resolve();
  assert.deepEqual(first.active(), ["mcp"]);
});

test("MCP 多个文本块共享输出预算", async (context) => {
  const parts = ["a".repeat(16 * 1024), "b".repeat(16 * 1024)];
  const run = await registerMcpResult({ content: parts.map((text) => ({ type: "text", text })) });
  const result = await run();
  const fullOutputPath = result.details.fullOutputPath;
  assert.equal(typeof fullOutputPath, "string");
  context.after(() => rm(fullOutputPath as string, { force: true }));
  assert.ok(Buffer.byteLength(result.content[0].text ?? "") < MCP_TEXT_LIMIT + 1024);
  assert.equal(await readFile(fullOutputPath as string, "utf8"), parts.join("\n"));
});

test("中文和 emoji 的 MCP 结果按字节限制，截断不破坏字符", async (context) => {
  const original = "汉字🙂".repeat(4096);
  const run = await registerMcpResult({ content: [{ type: "text", text: original }] });
  const result = await run();
  const fullOutputPath = result.details.fullOutputPath;
  assert.equal(typeof fullOutputPath, "string");
  context.after(() => rm(fullOutputPath as string, { force: true }));
  assert.ok(Buffer.byteLength(result.content[0].text ?? "") < MCP_TEXT_LIMIT + 1024);
  assert.doesNotMatch(result.content[0].text ?? "", /\uFFFD/);
  assert.equal(await readFile(fullOutputPath as string, "utf8"), original);
});

test("直接注册的 MCP 工具保留服务器返回的失败状态", async () => {
  const run = await registerMcpResult({ content: [{ type: "text", text: "Error: No page found" }], isError: true });
  const result = await run(true);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Error: No page found");
});

test("MCP 工具清单提供完整参数 schema，包含必填字段和嵌套约束", () => {
  const inputSchema = {
    type: "object",
    required: ["filters"],
    properties: { filters: { type: "object", required: ["status"], properties: { status: { enum: ["open", "closed"] } } } },
  };
  const rendered = describeServerTools("test-server", {
    status: "connected",
    tools: [{ name: "query", description: "Query records", inputSchema }],
  });
  assert.ok(rendered.includes(JSON.stringify(inputSchema)), "listing names alone makes the model guess required arguments");
});

for (const direct of [false, true]) {
  test(`${direct ? "直接注册" : "mcp 调用"}保留截图，同时限制附带的超长文本`, async (context) => {
    const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    const original = "snapshot".repeat(10_000);
    const run = await registerMcpResult({ content: [{ type: "text", text: original }, image] });
    const result = await run(direct);
    assert.deepEqual(result.content.find((part) => part.type === "image"), image, "screenshots must reach the model as images");
    const fullOutputPath = result.details.fullOutputPath;
    assert.equal(typeof fullOutputPath, "string");
    context.after(() => rm(fullOutputPath as string, { force: true }));
    const text = result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
    assert.ok(Buffer.byteLength(text) < MCP_TEXT_LIMIT + 1024);
    assert.equal(await readFile(fullOutputPath as string, "utf8"), original);
  });

  test(`${direct ? "直接注册" : "mcp 调用"}不丢弃只有 structuredContent 的结果`, async () => {
    const structuredContent = { rows: [{ id: 42 }], total: 1 };
    const run = await registerMcpResult({ content: [], structuredContent });
    const result = await run(direct);
    assert.deepEqual(JSON.parse(result.content[0].text ?? ""), structuredContent);
  });
}

test("MCP 返回的内嵌文本资源交给模型", async () => {
  const run = await registerMcpResult({ content: [{ type: "resource", resource: { uri: "docs://report", mimeType: "text/plain", text: "report content" } }] });
  const result = await run();
  assert.match(result.content.map((part) => part.text ?? "").join("\n"), /report content/);
});
