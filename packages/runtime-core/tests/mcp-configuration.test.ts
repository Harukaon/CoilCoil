import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpConfigurationForAgent, CoilCoilRuntime, withBundledBrowserMcp } from "../src/index.js";

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

test("bundled Chrome DevTools MCP is scoped per session with zero direct tools", () => {
  const source: { mcpServers: Record<string, Record<string, unknown>> } = { mcpServers: { ordinary: { command: "ordinary" } } };
  const result = withBundledBrowserMcp(source, {
    COILCOIL_BROWSER_MCP_COMMAND: "/private/node",
    COILCOIL_BROWSER_MCP_ARGS: JSON.stringify(["/private/devtools.js", "--wsEndpoint", "ws://127.0.0.1/devtools"]),
    COILCOIL_BROWSER_MCP_ENV: JSON.stringify({ CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1", ELECTRON_RUN_AS_NODE: "1" }),
  }, "runtime A/会话");
  assert.equal(source.mcpServers["coilcoil-browser"], undefined);
  assert.deepEqual(Object.keys(result.mcpServers), ["ordinary", "coilcoil-browser"]);
  assert.deepEqual(result.mcpServers["coilcoil-browser"], {
    command: "/private/node",
    args: ["/private/devtools.js", "--wsEndpoint", "ws://127.0.0.1/devtools?scope=runtime+A%2F%E4%BC%9A%E8%AF%9D"],
    env: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1", ELECTRON_RUN_AS_NODE: "1" },
    lifecycle: "eager",
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
