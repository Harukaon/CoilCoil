import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpConfigurationForAgent, SuoCodeRuntime, withBundledBrowserMcp } from "../src/index.js";

test("Agent MCP configuration contains enabled servers only", () => {
  const source = {
    imports: ["codex" as const],
    settings: { toolPrefix: "server" },
    mcpServers: {
      enabled: { command: "enabled-server", args: ["--stdio"] },
      disabledInDefinition: { command: "disabled-server", disabled: true },
      disabledBySuoCode: { command: "opted-out-server" },
      permanentlyDeleted: { command: "deleted-server" },
    },
  };

  const filtered = mcpConfigurationForAgent(
    source,
    new Set(["disabledBySuoCode", "permanentlyDeleted"]),
  );

  assert.deepEqual(Object.keys(filtered.mcpServers), ["enabled"]);
  assert.deepEqual(filtered.mcpServers.enabled, source.mcpServers.enabled);
  assert.notEqual(filtered.mcpServers.enabled, source.mcpServers.enabled);
  assert.deepEqual(Object.keys(source.mcpServers), [
    "enabled",
    "disabledInDefinition",
    "disabledBySuoCode",
    "permanentlyDeleted",
  ]);
});

test("bundled browser MCP layers are injected only into the Agent capability view", () => {
  const source: { mcpServers: Record<string, Record<string, unknown>> } = { mcpServers: { ordinary: { command: "ordinary" } } };
  const result = withBundledBrowserMcp(source, {
    SUOCODE_BROWSER_MCP_COMMAND: "/private/node",
    SUOCODE_BROWSER_MCP_ARGS: JSON.stringify(["/private/playwright.js", "--cdp-endpoint", "ws://127.0.0.1/playwright"]),
    SUOCODE_BROWSER_MCP_ENV: JSON.stringify({ ELECTRON_RUN_AS_NODE: "1" }),
    SUOCODE_BROWSER_DEVTOOLS_MCP_COMMAND: "/private/node",
    SUOCODE_BROWSER_DEVTOOLS_MCP_ARGS: JSON.stringify(["/private/devtools.js", "--wsEndpoint", "ws://127.0.0.1/devtools"]),
    SUOCODE_BROWSER_DEVTOOLS_MCP_ENV: JSON.stringify({ CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1", ELECTRON_RUN_AS_NODE: "1" }),
    SUOCODE_BROWSER_DEBUG_MCP_COMMAND: "/private/node",
    SUOCODE_BROWSER_DEBUG_MCP_ARGS: JSON.stringify(["/private/browser-debug-mcp.js"]),
    SUOCODE_BROWSER_DEBUG_MCP_ENV: JSON.stringify({ SUOCODE_BROWSER_DEBUG_CDP_ENDPOINT: "ws://127.0.0.1/devtools", SUOCODE_BROWSER_DEBUG_CDP_TOKEN: "secret" }),
  });
  assert.equal(source.mcpServers["suocode-browser"], undefined);
  assert.deepEqual(result.mcpServers["suocode-browser"], {
    command: "/private/node",
    args: ["/private/playwright.js", "--cdp-endpoint", "ws://127.0.0.1/playwright"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    lifecycle: "lazy-keep-alive",
    requestTimeoutMs: 180_000,
    directTools: [
      "browser_click", "browser_drag", "browser_drop", "browser_file_upload",
      "browser_fill_form", "browser_find", "browser_handle_dialog", "browser_hover", "browser_mouse_wheel",
      "browser_navigate", "browser_navigate_back",
      "browser_press_key", "browser_resize", "browser_select_option", "browser_snapshot", "browser_tabs",
      "browser_take_screenshot", "browser_type", "browser_wait_for",
    ],
    toolPrefix: "none",
    description: "以 Playwright 的语义化定位、自动等待和可执行性检查控制 SuoCode 右侧可见网页。",
    builtin: true,
  });
  assert.deepEqual(result.mcpServers["suocode-browser-devtools"], {
    command: "/private/node",
    args: ["/private/devtools.js", "--wsEndpoint", "ws://127.0.0.1/devtools"],
    env: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1", ELECTRON_RUN_AS_NODE: "1" },
    lifecycle: "lazy-keep-alive",
    requestTimeoutMs: 300_000,
    directTools: false,
    description: "按需提供 SuoCode 内置浏览器的网络、性能、内存、Lighthouse 等高级调试能力。",
    builtin: true,
  });
  assert.deepEqual(result.mcpServers["suocode-browser-debugger"], {
    command: "/private/node",
    args: ["/private/browser-debug-mcp.js"],
    env: { SUOCODE_BROWSER_DEBUG_CDP_ENDPOINT: "ws://127.0.0.1/devtools", SUOCODE_BROWSER_DEBUG_CDP_TOKEN: "secret" },
    lifecycle: "lazy-keep-alive",
    requestTimeoutMs: 300_000,
    directTools: false,
    description: "按需提供 SuoCode 内置浏览器的源码断点、单步、请求拦截、事件等待、HAR 与 Application 存储调试能力。",
    builtin: true,
  });
});

test("legacy removed-server tombstones are migrated out of Pi's configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "suocode-mcp-removal-"));
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

  const runtime = Object.create(SuoCodeRuntime.prototype) as {
    agentDir: string;
    refreshAgentMcpConfiguration(events: object, cwd: string): Promise<void>;
  };
  Object.defineProperty(runtime, "agentDir", { value: agentDir });
  const events = {};
  try {
    await runtime.refreshAgentMcpConfiguration(events, cwd);
    const registry = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("suocode-workflow.mcp-agent-config-registry")];
    assert.ok(registry instanceof WeakMap);
    const agentConfiguration = registry.get(events) as { mcpServers: Record<string, unknown> };
    assert.ok(agentConfiguration.mcpServers.enabled);
    assert.equal(agentConfiguration.mcpServers.node_repl, undefined);
    assert.equal(agentConfiguration.mcpServers["workspace-off"], undefined);

    const globalConfig = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    const projectConfig = JSON.parse(readFileSync(join(projectPiDir, "mcp.json"), "utf8"));
    const disabled = JSON.parse(readFileSync(join(agentDir, "mcp-disabled-servers.json"), "utf8"));
    assert.equal(globalConfig.mcpServers.node_repl, undefined);
    assert.equal(projectConfig.mcpServers.node_repl, undefined);
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
  const runtime = Object.create(SuoCodeRuntime.prototype) as {
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
