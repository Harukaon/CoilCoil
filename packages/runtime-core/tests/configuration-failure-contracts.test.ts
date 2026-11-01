import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { McpServerConfiguration } from "@coilcoil/runtime-protocol";
import { CoilCoilRuntime } from "../src/index.js";
import { RuntimeProviderSettings } from "../src/runtime-provider-settings.js";

interface ConfigHarness {
  agentDir: string;
  workspaceMcpConfigPath(cwd: string): string;
  workspaceMcpServers(cwd: string): Record<string, unknown>;
  writeWorkspaceMcpServer(cwd: string, name: string, definition: Record<string, unknown>): void;
  readNamedMcpServerSet(path: string): Set<string>;
  refreshAgentMcpConfiguration(events: object, cwd: string, scope: string): Promise<void>;
  getMcpConfiguration(cwd: string): Promise<unknown>;
  saveMcpServer(server: McpServerConfiguration, previousName?: string, cwd?: string): Promise<unknown>;
  importMcpServers(input: { servers: Array<{ origin: string; name: string }> }): Promise<unknown>;
  enableMcpImports(imports: ["codex"]): Promise<unknown>;
  getMcpJson(): Promise<{ content: string }>;
  saveMcpJson(content: string, cwd?: string): Promise<unknown>;
}

function harness(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "coil-config-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = Object.create(CoilCoilRuntime.prototype) as ConfigHarness;
  runtime.agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(runtime.agentDir);
  mkdirSync(cwd);
  return { runtime, root, cwd };
}

test("missing MCP files keep first-use defaults and the legacy server list remains supported", (t) => {
  const { runtime, cwd } = harness(t);
  assert.deepEqual(runtime.workspaceMcpServers(cwd), {});
  assert.deepEqual([...runtime.readNamedMcpServerSet(join(runtime.agentDir, "missing.json"))], []);
  const legacy = join(runtime.agentDir, "legacy.json");
  writeFileSync(legacy, '[" disabled-server "]');
  assert.deepEqual([...runtime.readNamedMcpServerSet(legacy)], ["disabled-server"]);
  runtime.writeWorkspaceMcpServer(cwd, "new", { command: "new-server" });
  assert.deepEqual(runtime.workspaceMcpServers(cwd), { new: { command: "new-server" } });
});

test("malformed MCP exclusion lists fail instead of re-enabling disabled or removed servers", (t) => {
  const { runtime } = harness(t);
  for (const content of ['{"servers": [', '{"servers": "disabled-server"}', '{"servers": [42]}', "null"]) {
    const path = join(runtime.agentDir, "mcp-disabled-servers.json");
    writeFileSync(path, content);
    assert.throws(() => runtime.readNamedMcpServerSet(path), /MCP|配置/);
    assert.equal(readFileSync(path, "utf8"), content);
  }
});

test("malformed workspace MCP configuration is neither treated as empty nor overwritten on save", (t) => {
  const { runtime, cwd } = harness(t);
  const path = runtime.workspaceMcpConfigPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  for (const content of ['{"mcpServers": {', '{"mcpServers": []}', '{"mcpServers": {"old": null}}', "null"]) {
    writeFileSync(path, content);
    assert.throws(() => runtime.workspaceMcpServers(cwd), /MCP|配置/);
    assert.throws(() => runtime.writeWorkspaceMcpServer(cwd, "new", { command: "new-server" }), /MCP|配置/);
    assert.equal(readFileSync(path, "utf8"), content);
  }
});

test("MCP permission failures are surfaced and never overwrite an unreadable workspace file", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, (t) => {
  const { runtime, cwd } = harness(t);
  const path = runtime.workspaceMcpConfigPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  const original = JSON.stringify({ mcpServers: { old: { command: "old-server" } } });
  writeFileSync(path, original);
  chmodSync(path, 0o000);
  try {
    assert.throws(() => runtime.writeWorkspaceMcpServer(cwd, "new", { command: "new-server" }), /EACCES|EPERM|权限/);
  } finally {
    chmodSync(path, 0o600);
  }
  assert.equal(readFileSync(path, "utf8"), original);
  const disabled = join(runtime.agentDir, "mcp-disabled-servers.json");
  writeFileSync(disabled, '{"servers":["old"]}');
  chmodSync(disabled, 0o000);
  try {
    assert.throws(() => runtime.readNamedMcpServerSet(disabled), /EACCES|EPERM|权限/);
  } finally {
    chmodSync(disabled, 0o600);
  }
});

test("MCP refresh and settings propagate invalid policy and retain the last agent configuration", async (t) => {
  const { runtime, cwd } = harness(t);
  writeFileSync(join(runtime.agentDir, "mcp.json"), JSON.stringify({ imports: [], mcpServers: { docs: { command: "docs-server" } } }));
  const disabled = join(runtime.agentDir, "mcp-disabled-servers.json");
  writeFileSync(disabled, '{"servers":["docs"]}');
  const events = {};
  await runtime.refreshAgentMcpConfiguration(events, cwd, "test-session");
  const registry = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("coilcoil-workflow.mcp-agent-config-registry")] as WeakMap<object, { mcpServers: Record<string, unknown> }>;
  const previous = registry.get(events);
  assert.equal(previous?.mcpServers.docs, undefined);
  writeFileSync(disabled, '{"servers":');
  await assert.rejects(runtime.refreshAgentMcpConfiguration(events, cwd, "test-session"), /MCP|配置/);
  await assert.rejects(runtime.getMcpConfiguration(cwd), /MCP|配置/);
  assert.equal(registry.get(events), previous, "an invalid policy must not replace the last accepted agent configuration");
});

test("provider removal stops on credential deletion failure and emits no success update", async (t) => {
  const { runtime } = harness(t);
  const configPath = join(runtime.agentDir, "models.json");
  const original = JSON.stringify({ providers: { custom: { api: "openai-completions", baseUrl: "https://example.invalid" } } });
  writeFileSync(configPath, original);
  const credentialPath = join(runtime.agentDir, "auth.json");
  writeFileSync(credentialPath, '{"custom":{"type":"api_key","key":"test-only"}}');
  let successUpdates = 0;
  Object.assign(runtime, {
    ready: async () => ({
      logout: async () => { throw new Error("ENOSPC: Credential store delete failed for custom"); },
      refresh: async () => {},
      getError: () => undefined,
    }),
    getConfiguration: async () => ({}),
    emitEvent: () => { successUpdates += 1; },
    refreshSessionModelFromRegistry: () => {},
  });
  await assert.rejects(RuntimeProviderSettings.prototype.removeModelProviderConfiguration.call(runtime as never, "custom"), /凭据|Credential store delete failed/);
  assert.equal(readFileSync(configPath, "utf8"), original);
  assert.equal(JSON.parse(readFileSync(credentialPath, "utf8")).custom.key, "test-only");
  assert.equal(successUpdates, 0);
});

const newServer: McpServerConfiguration = {
  name: "new", scope: "global", transport: "stdio", command: "new-server", args: [], env: {}, headers: {},
  lifecycle: "lazy", exposeResources: false, directTools: false, excludeTools: [], debug: false, disabled: false,
};

test("global MCP load failures reach both settings and agent refresh before adapter fallback", async (t) => {
  const { runtime, cwd } = harness(t);
  const path = join(runtime.agentDir, "mcp.json");
  for (const content of ['{"mcpServers":', '{"mcpServers": []}', '{"mcpServers": null}', '{"mcp-servers": {"old": null}}']) {
    writeFileSync(path, content);
    await assert.rejects(runtime.getMcpConfiguration(cwd), /MCP|配置/);
    await assert.rejects(runtime.refreshAgentMcpConfiguration({}, cwd, "test-session"), /MCP|配置/);
    assert.equal(readFileSync(path, "utf8"), content);
  }
});

test("all global adapter write entry points refuse to overwrite malformed config", async (t) => {
  const { runtime } = harness(t);
  const path = join(runtime.agentDir, "mcp.json");
  Object.assign(runtime, {
    discoverMcpServers: async () => ({ servers: [{ origin: "fixture", name: "new", definition: { command: "new-server" }, alreadyPresent: false }] }),
  });
  const operations = [
    () => runtime.saveMcpServer(newServer),
    () => runtime.importMcpServers({ servers: [{ origin: "fixture", name: "new" }] }),
    () => runtime.enableMcpImports(["codex"]),
  ];
  for (const operation of operations) {
    const content = '{"mcpServers":{"old":';
    writeFileSync(path, content);
    await assert.rejects(operation(), /MCP|配置/);
    assert.equal(readFileSync(path, "utf8"), content);
  }
});

test("global MCP JSONC comments, trailing commas and legacy server key remain supported", async (t) => {
  const { runtime, cwd } = harness(t);
  const path = join(runtime.agentDir, "mcp.json");
  writeFileSync(path, '{\n// existing format\n"imports": [], "mcp-servers": {"old": {"command": "old-server",},},\n}');
  const before = await runtime.getMcpConfiguration(cwd) as { servers: McpServerConfiguration[] };
  assert.ok(before.servers.some((server) => server.name === "old"));
  await runtime.saveMcpServer(newServer);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(saved.mcpServers.old, { command: "old-server" });
  assert.equal(saved.mcpServers.new.command, "new-server");
});

test("global MCP permission errors are not mistaken for a missing first-use file", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (t) => {
  const { runtime, cwd } = harness(t);
  const path = join(runtime.agentDir, "mcp.json");
  const original = '{"mcpServers":{"old":{"command":"old-server"}}}';
  writeFileSync(path, original);
  chmodSync(path, 0o000);
  try {
    await assert.rejects(runtime.getMcpConfiguration(cwd), /EACCES|EPERM|权限/);
    await assert.rejects(runtime.saveMcpServer(newServer), /EACCES|EPERM|权限/);
  } finally {
    chmodSync(path, 0o600);
  }
  assert.equal(readFileSync(path, "utf8"), original);
  chmodSync(runtime.agentDir, 0o000);
  try {
    await assert.rejects(runtime.getMcpJson(), /EACCES|EPERM|权限/);
  } finally {
    chmodSync(runtime.agentDir, 0o700);
  }
});

test("the MCP JSON editor can read and explicitly repair malformed content", async (t) => {
  const { runtime, cwd } = harness(t);
  const path = join(runtime.agentDir, "mcp.json");
  writeFileSync(path, '{"mcpServers":');
  assert.equal((await runtime.getMcpJson()).content, '{"mcpServers":');
  await runtime.saveMcpJson('{"mcpServers":{"fixed":{"command":"fixed-server"}}}', cwd);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).mcpServers.fixed.command, "fixed-server");
});
