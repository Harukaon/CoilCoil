import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { McpServerConfiguration } from "@coilcoil/runtime-protocol";
import { McpManager } from "../src/manager.ts";
import { McpCredentialStore } from "../src/credential-store.ts";
import { McpAuthCallbackServer } from "../src/auth-callback.ts";

function harness(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "coil-mcp-adversarial-"));
  const definition = { name: "documents", scope: "global", transport: "stdio", command: process.execPath,
    args: [fileURLToPath(new URL("../../../scripts/fixtures/mcp-adversarial-server.mjs", import.meta.url))],
    env: {}, headers: {}, lifecycle: "lazy", idleTimeout: 1, exposeResources: false, directTools: false,
    excludeTools: [], debug: false, disabled: false, requestTimeoutMs: 5000 } as McpServerConfiguration;
  const manager = new McpManager({ loadServers: () => [definition], store: new McpCredentialStore(join(root, "credentials.json")),
    callback: new McpAuthCallbackServer([0]), openAuthorization() {} });
  t.after(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }); });
  return { manager, root };
}

test("non-browser MCP tools keep their advertised names across browser alias collisions", async (t) => {
  const { manager } = harness(t);
  const tools = (await manager.serverTools("documents")).tools.filter((tool) => tool.name !== "wait");
  for (const tool of tools) {
    const result = await manager.callTool("documents", tool.name, {}) as { content: Array<{ text: string }>; isError?: boolean };
    assert.notEqual(result.isError, true, `advertised tool ${tool.name} must remain callable`);
    assert.equal(result.content[0].text, tool.name);
  }
});

test("idle collection never closes an active MCP call and counts concurrent calls independently", async (t) => {
  const { manager, root } = harness(t);
  await manager.connect("documents");
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const internal = manager as unknown as { sweepIdleConnections(): void };
  const releases = [join(root, "release0"), join(root, "release1")];
  t.after(() => { for (const release of releases) if (existsSync(root)) writeFileSync(release, "done"); });
  const pending = [0, 1].map((index) => manager.callTool("documents", "wait", {
    readyPath: join(root, `ready${index}`), releasePath: releases[index],
  }).then((result) => ({ result }), (error: unknown) => ({ error })));
  for (let attempt = 0; ![0, 1].every((index) => existsSync(join(root, `ready${index}`))); attempt++) {
    assert.ok(attempt < 500, "both tool calls must reach the real server");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  now += 60_001;
  internal.sweepIdleConnections();
  assert.equal((await manager.status()).connectedCount, 1, "in-flight work is not idle");
  writeFileSync(releases[0], "done");
  assert.ok("result" in await pending[0]);
  now += 60_001;
  internal.sweepIdleConnections();
  assert.equal((await manager.status()).connectedCount, 1, "one completion must not release another call's lease");
  writeFileSync(releases[1], "done");
  assert.ok("result" in await pending[1]);
  now += 59_999;
  internal.sweepIdleConnections();
  assert.equal((await manager.status()).connectedCount, 1, "idle time starts at the last completion");
  now += 2;
  internal.sweepIdleConnections();
  assert.equal((await manager.status()).connectedCount, 0, "completed work remains eligible for normal idle collection");
});
