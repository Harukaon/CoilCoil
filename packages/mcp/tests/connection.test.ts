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

test("服务器起不来时，把它自己在 stderr 上说的那句话带出来", async () => {
  // 「连接失败」四个字打发不了人。服务器多半已经说了原因，只是没人转达。
  const link = connection(server({
    command: process.execPath,
    args: ["-e", "process.stderr.write('Cannot find module \\'nope\\''); process.exit(1)"],
  }));
  assert.equal(await link.connect(), "failed");
  assert.match(link.failure ?? "", /Cannot find module 'nope'/);
});

test("服务器啰嗦也不会把面板撑爆", async () => {
  const link = connection(server({
    command: process.execPath,
    args: ["-e", "process.stderr.write('x'.repeat(50000)); process.exit(1)"],
  }));
  assert.equal(await link.connect(), "failed");
  assert.ok((link.failure ?? "").length < 1200, `失败信息过长：${(link.failure ?? "").length}`);
});

test("服务器接了连接却不说话，不会永远挂着", async (t) => {
  // SDK 只给自己的请求设了超时，connect 没有。而 Agent 是并行列服务器的，
  // 一个这样的服务器以前会把其他所有服务器的答案一起拖死。
  const { createServer } = await import("node:http");
  const hanging = createServer(() => { /* 永远不回应 */ });
  await new Promise((ready) => hanging.listen(0, "127.0.0.1", ready));
  const { port } = hanging.address() as { port: number };
  t.after(() => new Promise((done) => { hanging.closeAllConnections?.(); hanging.close(() => done(undefined)); }));

  const link = connection(server({
    transport: "http",
    command: undefined,
    url: `http://127.0.0.1:${port}/mcp`,
    auth: false,
    requestTimeoutMs: 700,
  }));
  const started = Date.now();
  assert.equal(await link.connect(), "failed");
  assert.ok(Date.now() - started < 8_000, "超时没有生效");
  assert.match(link.failure ?? "", /超时/);
});

/** 这条连接手上那个子进程；stdio 传输把它自己的 pid 露出来给的就是这种用途。 */
function childPid(link: McpConnection): number {
  const pid = (link as unknown as { transport?: { pid?: number | null } }).transport?.pid;
  assert.ok(typeof pid === "number", "stdio 连接应该有一个子进程");
  return pid;
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("等条件成立等超时了");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("服务器在背后死掉，状态就说断了，不接着报已连接", async (t) => {
  // 真实的事故：内置浏览器的 MCP 半路断了，而这一层照旧说「已连接」，工具清单还
  // 从缓存里照答，于是每一次调用都是 Not connected，自动重连又被这句谎话挡住。
  const link = connection(server());
  t.after(() => link.close());
  assert.equal(await link.connect(), "connected");

  process.kill(childPid(link), "SIGKILL");
  await until(() => link.status === "not connected");
  assert.deepEqual(link.tools, [], "连接没了，工具清单也不该再从缓存里端出来");
});

test("断过之后再调一次工具，它自己会重连", async (t) => {
  const link = connection(server());
  t.after(() => link.close());
  assert.equal(await link.connect(), "connected");
  const first = childPid(link);

  process.kill(first, "SIGKILL");
  await until(() => link.status === "not connected");

  const result = await link.callTool("echo", { text: "again" }) as { content: Array<{ text?: string }> };
  assert.equal(result.content[0]?.text, "MCP_ECHO:again");
  assert.notEqual(childPid(link), first, "应该是重新连的一条，不是原来那条");
});
