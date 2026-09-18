import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpConfigurationForAgent, CoilCoilRuntime, serveMcpManager, withBundledBrowserMcp } from "../src/index.js";
import { BROWSER_IDLE_TIMEOUT_MINUTES, bundledBrowserServerConfiguration, withoutRivalBrowserConfigurations } from "../src/browser-mcp.js";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { requestMcpManager } from "../../workflow/extensions/mcp-tools.js";

test("Agent MCP configuration contains enabled servers only", () => {
  const source = {
    imports: ["codex" as const],
    settings: { toolPrefix: "server" },
    mcpServers: {
      enabled: { command: "enabled-server", args: ["--stdio"] },
      disabledInDefinition: { command: "disabled-server", disabled: true },
      disabledByCoilCoil: { command: "opted-out-server" },
      permanentlyDeleted: { command: "deleted-server" },
    },
  };

  const filtered = mcpConfigurationForAgent(
    source,
    new Set(["disabledByCoilCoil", "permanentlyDeleted"]),
  );

  assert.deepEqual(Object.keys(filtered.mcpServers), ["enabled"]);
  assert.deepEqual(filtered.mcpServers.enabled, source.mcpServers.enabled);
  assert.notEqual(filtered.mcpServers.enabled, source.mcpServers.enabled);
  assert.deepEqual(Object.keys(source.mcpServers), [
    "enabled",
    "disabledInDefinition",
    "disabledByCoilCoil",
    "permanentlyDeleted",
  ]);
});

test("bundled Chrome DevTools MCP is scoped per workspace with zero direct tools", () => {
  const source: { mcpServers: Record<string, Record<string, unknown>> } = { mcpServers: { ordinary: { command: "ordinary" } } };
  const result = withBundledBrowserMcp(source, {
    COILCOIL_BROWSER_MCP_COMMAND: "/private/node",
    COILCOIL_BROWSER_MCP_ARGS: JSON.stringify(["/private/devtools.js", "--wsEndpoint", "ws://127.0.0.1/devtools"]),
    COILCOIL_BROWSER_MCP_ENV: JSON.stringify({ CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1", ELECTRON_RUN_AS_NODE: "1" }),
  }, "/Users/hao/项目 A");
  assert.equal(source.mcpServers["coilcoil-browser"], undefined);
  assert.deepEqual(Object.keys(result.mcpServers), ["ordinary", "coilcoil-browser"]);
  assert.deepEqual(result.mcpServers["coilcoil-browser"], {
    command: "/private/node",
    args: ["/private/devtools.js", "--wsEndpoint", "ws://127.0.0.1/devtools?scope=%2FUsers%2Fhao%2F%E9%A1%B9%E7%9B%AE+A"],
    env: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1", ELECTRON_RUN_AS_NODE: "1" },
    lifecycle: "lazy",
    idleTimeout: BROWSER_IDLE_TIMEOUT_MINUTES,
    requestTimeoutMs: 300_000,
    directTools: false,
    description: "通过 Chrome DevTools MCP 按需控制和调试 CoilCoil 右侧可见网页。",
    builtin: true,
  });
});

test("a removed server is swept from CoilCoil's own files and never from the workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-mcp-removal-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const projectPiDir = join(cwd, ".pi");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectPiDir, { recursive: true });
  writeFileSync(join(agentDir, "mcp.json"), `${JSON.stringify({
    imports: [],
    mcpServers: {
      enabled: { command: "enabled-server" },
      node_repl: { disabled: true },
    },
  }, null, 2)}\n`);
  writeFileSync(join(agentDir, "mcp-removed-servers.json"), `${JSON.stringify({ servers: ["node_repl"] }, null, 2)}\n`);
  writeFileSync(join(agentDir, "mcp-disabled-servers.json"), `${JSON.stringify({ servers: ["node_repl", "workspace-off"] }, null, 2)}\n`);
  writeFileSync(join(projectPiDir, "mcp.json"), `${JSON.stringify({ mcpServers: { node_repl: { disabled: true } } }, null, 2)}\n`);

  const runtime = Object.create(CoilCoilRuntime.prototype) as {
    agentDir: string;
    refreshAgentMcpConfiguration(events: object, cwd: string): Promise<void>;
  };
  Object.defineProperty(runtime, "agentDir", { value: agentDir });
  const events = {};
  try {
    await runtime.refreshAgentMcpConfiguration(events, cwd);
    const registry = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("coilcoil-workflow.mcp-agent-config-registry")];
    assert.ok(registry instanceof WeakMap);
    const agentConfiguration = registry.get(events) as { mcpServers: Record<string, unknown> };
    assert.ok(agentConfiguration.mcpServers.enabled);
    assert.equal(agentConfiguration.mcpServers.node_repl, undefined);
    assert.equal(agentConfiguration.mcpServers["workspace-off"], undefined);

    const globalConfig = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    const projectConfig = JSON.parse(readFileSync(join(projectPiDir, "mcp.json"), "utf8"));
    const disabled = JSON.parse(readFileSync(join(agentDir, "mcp-disabled-servers.json"), "utf8"));
    assert.equal(globalConfig.mcpServers.node_repl, undefined);
    // The workspace file belongs to the project, not to CoilCoil: a refresh
    // reads it and leaves it exactly as it found it.
    assert.deepEqual(projectConfig.mcpServers.node_repl, { disabled: true });
    assert.deepEqual(disabled.servers, ["workspace-off"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an idle MCP configuration change waits for the live session reload", async () => {
  let finishReload: (() => void) | undefined;
  const reloadFinished = new Promise<void>((resolve) => {
    finishReload = resolve;
  });
  const active = {};
  const runtime = Object.create(CoilCoilRuntime.prototype) as {
    active: object;
    canReloadActiveSession(value: object): boolean;
    reloadActiveSessionNow(value: object): Promise<void>;
    reloadMcpExtensionNow(): Promise<void>;
  };
  runtime.active = active;
  runtime.canReloadActiveSession = (value) => value === active;
  runtime.reloadActiveSessionNow = async (value) => {
    assert.equal(value, active);
    await reloadFinished;
  };

  let returned = false;
  const request = runtime.reloadMcpExtensionNow().then(() => {
    returned = true;
  });
  await Promise.resolve();
  assert.equal(returned, false, "the configuration request must not outrun the session reload");
  finishReload?.();
  await request;
  assert.equal(returned, true);
});

test("a workspace's own servers are stored in the agent directory, not in the workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-mcp-workspace-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, "mcp.json"), `${JSON.stringify({ imports: [], mcpServers: { shared: { command: "shared-server" } } }, null, 2)}\n`);

  const runtime = Object.create(CoilCoilRuntime.prototype) as {
    agentDir: string;
    workspaceMcpConfigPath(cwd: string): string;
    writeWorkspaceMcpServer(cwd: string, name: string, definition: Record<string, unknown> | undefined): void;
    refreshAgentMcpConfiguration(events: object, cwd: string): Promise<void>;
  };
  Object.defineProperty(runtime, "agentDir", { value: agentDir });
  const events = {};
  try {
    runtime.writeWorkspaceMcpServer(cwd, "workspace-only", { command: "workspace-server" });

    const storedPath = runtime.workspaceMcpConfigPath(cwd);
    assert.ok(storedPath.startsWith(join(agentDir, "workspaces")), storedPath);
    assert.equal(existsSync(join(cwd, ".pi")), false, "nothing may be written into the workspace");

    await runtime.refreshAgentMcpConfiguration(events, cwd);
    const registry = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("coilcoil-workflow.mcp-agent-config-registry")];
    assert.ok(registry instanceof WeakMap);
    const agentConfiguration = registry.get(events) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(agentConfiguration.mcpServers["workspace-only"], { command: "workspace-server" });
    assert.ok(agentConfiguration.mcpServers.shared);

    runtime.writeWorkspaceMcpServer(cwd, "workspace-only", undefined);
    const stored = JSON.parse(readFileSync(storedPath, "utf8")) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(stored.mcpServers, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each workspace gets its own stored configuration", () => {
  const runtime = Object.create(CoilCoilRuntime.prototype) as {
    agentDir: string;
    workspaceMcpConfigPath(cwd: string): string;
  };
  Object.defineProperty(runtime, "agentDir", { value: "/agent" });
  const first = runtime.workspaceMcpConfigPath("/tmp/alpha");
  const second = runtime.workspaceMcpConfigPath("/tmp/beta");
  const sameName = runtime.workspaceMcpConfigPath("/elsewhere/alpha");
  assert.notEqual(first, second);
  assert.notEqual(first, sameName, "two workspaces sharing a folder name must not share a file");
  assert.match(first, /alpha-[0-9a-f]{12}\/mcp\.json$/);
});

test("an imported chrome-devtools server that drives some other browser is dropped", () => {
  const configuration = withBundledBrowserMcp({
    mcpServers: {
      // What CoilCoil imports from another tool's config: no endpoint, so it
      // attaches to whatever Chrome happens to be on the machine.
      "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
      keenable: { url: "https://api.keenable.ai/mcp" },
    },
  }, {
    COILCOIL_BROWSER_MCP_COMMAND: "/private/node",
    COILCOIL_BROWSER_MCP_ARGS: JSON.stringify(["/private/devtools.js", "--wsEndpoint", "ws://127.0.0.1/devtools"]),
  });

  assert.deepEqual(Object.keys(configuration.mcpServers).sort(), ["coilcoil-browser", "keenable"]);
});

test("a devtools server aimed at a named browser is left alone", () => {
  const configuration = withBundledBrowserMcp({
    mcpServers: {
      "my-chrome": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:9222"] },
    },
  }, {
    COILCOIL_BROWSER_MCP_COMMAND: "/private/node",
    COILCOIL_BROWSER_MCP_ARGS: JSON.stringify(["/private/devtools.js", "--wsEndpoint", "ws://127.0.0.1/devtools"]),
  });

  assert.ok(configuration.mcpServers["my-chrome"]);
  assert.ok(configuration.mcpServers["coilcoil-browser"]);
});

test("扩展隔着 Pi 包出来的那层 wrapper 也拿得到运行时的 MCP 客户端", () => {
  // Pi 给扩展的是一个 {emit, on} 包装，不是总线本身，所以按对象身份查一定查不到；
  // 在总线上应答才真的送得到扩展手里。
  const bus = createEventBus();
  const manager = { marker: "runtime-manager" };
  serveMcpManager(bus, () => manager);

  const wrapper = {
    emit: (channel: string, data: unknown) => bus.emit(channel, data),
    on: (channel: string, handler: (data: unknown) => void) => bus.on(channel, handler),
  };
  assert.equal(requestMcpManager(wrapper as never), manager as never);
});

test("没人应答就是没有，不是拿一个过期的答案顶上", () => {
  const bus = createEventBus();
  const wrapper = { emit: (channel: string, data: unknown) => bus.emit(channel, data) };
  assert.equal(requestMcpManager(wrapper as never), undefined);
});

test("内置浏览器 MCP 也要以客户端认得的形状给出来", () => {
  // 这就是漏掉的那一环：内置浏览器不在工作区的 mcp.json 里，是桌面端用环境
  // 变量接上去的。旧的适配器从另一条路拿到它，新客户端读的是配置里的服务器
  // 列表，于是它就这么无声无息地从 Agent 面前消失了。
  const server = bundledBrowserServerConfiguration({
    COILCOIL_BROWSER_MCP_COMMAND: "/private/node",
    COILCOIL_BROWSER_MCP_ARGS: JSON.stringify(["/devtools.js", "--wsEndpoint", "ws://127.0.0.1/devtools"]),
    COILCOIL_BROWSER_MCP_ENV: JSON.stringify({ ELECTRON_RUN_AS_NODE: "1" }),
  }, "会话 A");
  assert.equal(server?.name, "coilcoil-browser");
  assert.equal(server?.transport, "stdio");
  assert.equal(server?.command, "/private/node");
  // 按需连接、闲下来就放手：开机就连会让每个留着的空闲会话各挂一个子进程。
  assert.equal(server?.lifecycle, "lazy", "内置浏览器要等 Agent 真用到才连");
  assert.equal(server?.idleTimeout, BROWSER_IDLE_TIMEOUT_MINUTES, "闲置之后要能被回收掉");
  assert.equal(server?.disabled, false);
  // 作用域跟着会话走，两个会话不会抢同一个浏览器。
  assert.ok(server?.args.some((value) => value.includes("scope=")));
});

test("没有配好浏览器环境时就当没有这个服务器", () => {
  assert.equal(bundledBrowserServerConfiguration({}), undefined);
});

test("用户自己配的 chrome-devtools 会给内置的让路", () => {
  // 两个 Chrome DevTools 服务器抢同一个浏览器，比只有一个更糟。
  const kept = withoutRivalBrowserConfigurations([
    { name: "普通", command: "npx", args: ["some-server"] },
    { name: "抢的", command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
    { name: "指定浏览器的", command: "npx", args: ["chrome-devtools-mcp", "--browserUrl", "http://127.0.0.1:9222"] },
  ] as never);
  assert.deepEqual(kept.map((server) => server.name), ["普通", "指定浏览器的"]);
});
