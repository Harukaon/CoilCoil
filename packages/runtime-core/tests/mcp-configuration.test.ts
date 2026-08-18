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

test("bundled Chrome DevTools MCP is scoped per session with zero direct tools", () => {
  const source: { mcpServers: Record<string, Record<string, unknown>> } = { mcpServers: { ordinary: { command: "ordinary" } } };
  const result = withBundledBrowserMcp(source, {
    SUOCODE_BROWSER_MCP_COMMAND: "/private/node",
    SUOCODE_BROWSER_MCP_ARGS: JSON.stringify(["/private/devtools.js", "--wsEndpoint", "ws://127.0.0.1/devtools"]),
    SUOCODE_BROWSER_MCP_ENV: JSON.stringify({ CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1", ELECTRON_RUN_AS_NODE: "1" }),
  }, "runtime A/会话");
  assert.equal(source.mcpServers["suocode-browser"], undefined);
  assert.deepEqual(Object.keys(result.mcpServers), ["ordinary", "suocode-browser"]);
  assert.deepEqual(result.mcpServers["suocode-browser"], {
    command: "/private/node",
    args: ["/private/devtools.js", "--wsEndpoint", "ws://127.0.0.1/devtools?scope=runtime+A%2F%E4%BC%9A%E8%AF%9D"],
    env: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1", ELECTRON_RUN_AS_NODE: "1" },
    lifecycle: "eager",
    requestTimeoutMs: 300_000,
    directTools: false,
    description: "通过 Chrome DevTools MCP 按需控制和调试 SuoCode 右侧可见网页。",
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
