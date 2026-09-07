import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfiguration } from "@coilcoil/runtime-protocol";
import { McpCredentialStore, defaultCredentialFile } from "../src/credential-store.ts";
import { McpConnection } from "../src/connection.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SMOKE_SERVER = resolve(here, "../../../scripts/fixtures/mcp-smoke-server.mjs");

function server(overrides: Partial<McpServerConfiguration> = {}): McpServerConfiguration {
  return {
    name: "smoke",
    scope: "global",
    transport: "stdio",
    command: process.execPath,
    args: [SMOKE_SERVER],
    env: {},
    headers: {},
    lifecycle: "lazy",
    exposeResources: false,
    directTools: false,
    excludeTools: [],
    debug: false,
    disabled: false,
    requestTimeoutMs: 20_000,
    ...overrides,
  } as McpServerConfiguration;
}

function connection(definition: McpServerConfiguration): McpConnection {
  const directory = mkdtempSync(join(tmpdir(), "coilcoil-mcp-conn-"));
  return new McpConnection({
    definition,
    store: new McpCredentialStore(defaultCredentialFile(join(directory, "agent"))),
    redirectUrl: "http://127.0.0.1:7891/callback",
    openAuthorization: () => undefined,
  });
}

test("连上 stdio 服务器、认得出它的工具、也调得动", async (t) => {
  const link = connection(server());
  t.after(() => link.close());
  assert.equal(link.status, "not connected");

  assert.equal(await link.connect(), "connected");
  assert.deepEqual(link.tools.map((tool) => tool.name), ["echo"]);

  const result = await link.callTool("echo", { text: "hi" }) as { content: Array<{ text?: string }> };
  assert.equal(result.content[0]?.text, "MCP_ECHO:hi");
});

test("排除掉的工具不出现在清单里", async (t) => {
  const link = connection(server({ excludeTools: ["echo"] }));
  t.after(() => link.close());
  assert.equal(await link.connect(), "connected");
  assert.deepEqual(link.tools, []);
});

test("只有开了资源开关才去问资源", async (t) => {
  const off = connection(server());
  t.after(() => off.close());
  await off.connect();
  assert.deepEqual(off.resources, []);

  const on = connection(server({ exposeResources: true }));
  t.after(() => on.close());
  await on.connect();
  assert.deepEqual(on.resources.map((item) => item.uri), ["coilcoil://smoke/resource"]);
});

test("命令不存在是一个答案，不是一个异常", async () => {
  // 面板要的是服务器自己那句话，不是一句「连接失败」。
  const link = connection(server({ command: "coilcoil-definitely-not-a-command" }));
  assert.equal(await link.connect(), "failed");
  assert.match(link.failure ?? "", /ENOENT|not found|spawn/i);
  assert.deepEqual(link.tools, []);
});

test("没填命令就当场说清楚是哪个服务器，也不算连上", async () => {
  const link = connection(server({ command: undefined }));
  assert.equal(await link.connect(), "failed");
  assert.match(link.failure ?? "", /smoke/);
});

test("连着的时候重复按不会再连一次", async (t) => {
  const link = connection(server());
  t.after(() => link.close());
  assert.equal(await link.connect(), "connected");
  const before = link.tools;
  assert.equal(await link.connect(), "connected");
  assert.equal(link.tools, before, "已经连上就直接用现成的，不重开一条连接");
});

test("同时按两下只会真的连一次", async (t) => {
  const link = connection(server());
  t.after(() => link.close());
  const [first, second] = await Promise.all([link.connect(), link.connect()]);
  assert.equal(first, "connected");
  assert.equal(second, "connected");
});

test("关掉之后状态和清单都回到最初", async () => {
  const link = connection(server());
  await link.connect();
  await link.close();
  assert.equal(link.status, "not connected");
  assert.deepEqual(link.tools, []);
});

test("没连上的时候调工具会把原因带出来", async () => {
  const link = connection(server({ command: "coilcoil-definitely-not-a-command" }));
  await assert.rejects(() => link.callTool("echo", { text: "hi" }), /ENOENT|not found|spawn/i);
});
