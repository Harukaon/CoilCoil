import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfiguration } from "@coilcoil/runtime-protocol";
import { McpAuthCallbackServer } from "../src/auth-callback.ts";
import { McpCredentialStore, credentialKey, defaultCredentialFile } from "../src/credential-store.ts";
import { McpManager, authorizationCode, authorizationState } from "../src/manager.ts";

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

function manager(servers: McpServerConfiguration[]): { manager: McpManager; store: McpCredentialStore; opened: URL[]; servers: McpServerConfiguration[] } {
  const directory = mkdtempSync(join(tmpdir(), "coilcoil-mcp-manager-"));
  const store = new McpCredentialStore(defaultCredentialFile(join(directory, "agent")));
  const opened: URL[] = [];
  const live = [...servers];
  return {
    store,
    opened,
    servers: live,
    manager: new McpManager({
      loadServers: () => live,
      store,
      callback: new McpAuthCallbackServer([0]),
      openAuthorization: (url) => { opened.push(url); },
    }),
  };
}

test("没连过任何东西也报得出状态，不需要任何会话", async (t) => {
  // 这就是换掉 pi-mcp-adapter 要解决的那件事：设置界面随时问得到。
  const { manager: mcp } = manager([server()]);
  t.after(() => mcp.close());
  const status = await mcp.status();
  assert.deepEqual(status.servers.map((entry) => entry.name), ["smoke"]);
  assert.equal(status.servers[0]?.status, "not connected");
  assert.equal(status.connectedCount, 0);
  assert.equal(status.state, "ready");
});

test("检查一次就真的连上，工具数也跟着报出来", async (t) => {
  const { manager: mcp } = manager([server()]);
  t.after(() => mcp.close());
  const result = await mcp.connect("smoke");
  assert.equal(result.status, "connected");
  assert.equal(result.toolCount, 1);
  const status = await mcp.status();
  assert.equal(status.connectedCount, 1);
  assert.equal(status.totalTools, 1);
});

test("连不上就把服务器自己那句话留着，并记下过了多久", async (t) => {
  const { manager: mcp } = manager([server({ command: "coilcoil-definitely-not-a-command" })]);
  t.after(() => mcp.close());
  const result = await mcp.connect("smoke");
  assert.equal(result.status, "failed");
  assert.match(mcp.failure("smoke") ?? "", /ENOENT|not found|spawn/i);
  assert.equal(typeof result.failedAgo, "number");
});

test("停用的服务器不会因为被问一句就被连起来", async (t) => {
  // 「检查状态」是个问题，不该顺手把用户关掉的东西打开。
  const { manager: mcp } = manager([server({ disabled: true })]);
  t.after(() => mcp.close());
  const result = await mcp.connect("smoke");
  assert.equal(result.status, "disabled");
  assert.equal(result.toolCount, 0);
});

test("改了定义就重新连，不会拿着旧地址旧请求头继续用", async (t) => {
  const { manager: mcp, servers } = manager([server()]);
  t.after(() => mcp.close());
  assert.equal((await mcp.connect("smoke")).status, "connected");
  // 改成一个起不来的命令：如果还复用旧连接，这里会仍然显示 connected。
  servers[0] = server({ command: "coilcoil-definitely-not-a-command" });
  const status = await mcp.status();
  assert.equal(status.servers[0]?.status, "not connected");
  assert.equal((await mcp.connect("smoke")).status, "failed");
});

test("配置里删掉的服务器会从状态里消失", async (t) => {
  const { manager: mcp, servers } = manager([server(), server({ name: "second" })]);
  t.after(() => mcp.close());
  assert.equal((await mcp.status()).servers.length, 2);
  servers.pop();
  assert.deepEqual((await mcp.status()).servers.map((entry) => entry.name), ["smoke"]);
});

test("Agent 拿得到工具，也调得动", async (t) => {
  const { manager: mcp } = manager([server()]);
  t.after(() => mcp.close());
  await mcp.connect("smoke");
  const listed = await mcp.listTools();
  assert.deepEqual(listed.tools.map((entry) => [entry.server, entry.tool.name]), [["smoke", "echo"]]);
  assert.deepEqual(listed.unavailable, []);
  const result = await mcp.callTool("smoke", "echo", { text: "hi" }) as { content: Array<{ text?: string }> };
  assert.equal(result.content[0]?.text, "MCP_ECHO:hi");
});

test("问「有什么工具」就真的去连着问，不是回一句空的", async (t) => {
  // 会话一开不会去启动任何服务器；但模型明确问「现在有什么」的时候，从一个
  // 因为还没人用过所以本来就是空的缓存里回答，等于告诉它这里什么都没有。
  const { manager: mcp } = manager([server()]);
  t.after(() => mcp.close());
  assert.equal((await mcp.status()).servers[0]?.status, "not connected", "光看状态不该连");
  const listed = await mcp.listTools();
  assert.deepEqual(listed.tools.map((entry) => entry.tool.name), ["echo"]);
  assert.equal((await mcp.status()).servers[0]?.status, "connected");
});

test("连不上的服务器会被点名，而不是从清单里悄悄消失", async (t) => {
  // 模型以为该有的工具找不到，和这个工具压根不存在，长得一模一样——只会让它
  // 继续瞎猜，而不是说出哪里不对。
  const { manager: mcp } = manager([
    server(),
    server({ name: "broken", command: "coilcoil-definitely-not-a-command" }),
  ]);
  t.after(() => mcp.close());
  const listed = await mcp.listTools();
  assert.deepEqual(listed.tools.map((entry) => entry.server), ["smoke"]);
  assert.deepEqual(listed.unavailable.map((entry) => [entry.server, entry.status]), [["broken", "failed"]]);
  assert.match(listed.unavailable[0]?.failure ?? "", /ENOENT|not found|spawn/i);
});

test("标了「启动时」的服务器会被主动连上", async (t) => {
  const { manager: mcp } = manager([server({ lifecycle: "eager" })]);
  t.after(() => mcp.close());
  await mcp.startEagerServers();
  assert.equal((await mcp.status()).connectedCount, 1);
  assert.equal((await mcp.listTools()).tools.length, 1);
});

test("会话内停用只挡 Agent，不改配置也不断连接", async (t) => {
  const { manager: mcp } = manager([server()]);
  t.after(() => mcp.close());
  await mcp.connect("smoke");
  mcp.setSessionEnabled("smoke", false);

  const status = await mcp.status();
  assert.equal(status.servers[0]?.sessionDisabled, true);
  assert.equal(status.servers[0]?.disabled, false, "配置本身没被改动");
  assert.equal(status.sessionDisabledCount, 1);
  assert.deepEqual((await mcp.listTools()).tools, []);
  await assert.rejects(() => mcp.callTool("smoke", "echo", { text: "x" }), /当前会话停用/);

  mcp.setSessionEnabled("smoke", true);
  // 中途开回来不该再付一次重连。
  assert.equal((await mcp.status()).servers[0]?.status, "connected");
});

test("停用的服务器 Agent 一个工具都看不到", async (t) => {
  const { manager: mcp } = manager([server({ disabled: true })]);
  t.after(() => mcp.close());
  assert.deepEqual((await mcp.listTools()).tools, []);
  await assert.rejects(() => mcp.callTool("smoke", "echo", { text: "x" }), /已停用/);
});

test("不认识的服务器直接说不认识", async (t) => {
  const { manager: mcp } = manager([server()]);
  t.after(() => mcp.close());
  await assert.rejects(() => mcp.connect("nope"), /没有找到/);
  await assert.rejects(() => mcp.callTool("nope", "echo", {}), /没有找到/);
});

test("stdio 服务器不走浏览器认证，也不会白开一个端口", async (t) => {
  const { manager: mcp } = manager([server()]);
  t.after(() => mcp.close());
  const started = await mcp.startAuth("smoke");
  assert.equal(started.awaitingCallback, false);
  assert.match(started.error ?? "", /不走浏览器认证/);
});

test("登出会把这个地址的凭据整条删掉", async (t) => {
  const { manager: mcp, store } = manager([
    server({ name: "remote", transport: "http", url: "https://mcp.example.com/v1", command: undefined }),
  ]);
  t.after(() => mcp.close());
  store.update(credentialKey("https://mcp.example.com/v1"), { tokens: { access_token: "t" } });
  await mcp.logout("remote");
  assert.equal(store.get(credentialKey("https://mcp.example.com/v1")), undefined);
});

test("从授权地址里读得出等回调用的那个 state", () => {
  assert.equal(authorizationState("https://auth.example.com/a?state=s-1&client_id=x"), "s-1");
  assert.equal(authorizationState("https://auth.example.com/a"), undefined);
  assert.equal(authorizationState("https://auth.example.com/a?state=%20"), undefined);
  assert.equal(authorizationState("不是地址"), undefined);
  assert.equal(authorizationState(undefined), undefined);
});

test("粘回来的东西不管是整条地址还是光秃秃的码都认", () => {
  // 卡在最后一步纯粹是因为格式挑剔，这种事不该发生。
  assert.equal(authorizationCode("http://127.0.0.1:7842/callback?code=abc&state=s"), "abc");
  assert.equal(authorizationCode("?code=abc&state=s"), "abc");
  assert.equal(authorizationCode("  abc-123  "), "abc-123");
  assert.equal(authorizationCode(""), undefined);
  assert.equal(authorizationCode("这是一句话 带空格"), undefined);
});

test("没等到回调就来认领会直接说清楚", async (t) => {
  const { manager: mcp } = manager([server()]);
  t.after(() => mcp.close());
  await assert.rejects(() => mcp.awaitAuth("smoke"), /没有等待中的授权/);
  await assert.rejects(() => mcp.completeAuth("smoke", "这不是码 带空格"), /没能.*认出授权码/);
});

test("关掉之后连接全部收干净", async () => {
  const { manager: mcp } = manager([server()]);
  await mcp.connect("smoke");
  await mcp.close();
  assert.equal((await mcp.status()).connectedCount, 0);
});

test("只有明确要求直接注册的服务器才进 directTools", async (t) => {
  // 直接注册的工具每一轮都躺在模型的 schema 里，不管用不用都在付 token，
  // 所以这是一件要用户明说的事。
  const { manager: mcp, servers } = manager([server()]);
  t.after(() => mcp.close());
  assert.deepEqual(await mcp.directTools(), []);

  servers[0] = server({ directTools: true });
  assert.deepEqual((await mcp.directTools()).map((entry) => entry.tool.name), ["echo"]);
});

test("directTools 给了名单就只注册名单里那几个", async (t) => {
  const { manager: mcp } = manager([server({ directTools: ["不存在的工具"] })]);
  t.after(() => mcp.close());
  assert.deepEqual(await mcp.directTools(), []);
});

test("停用的服务器不会因为 directTools 就被 Agent 看到", async (t) => {
  const { manager: mcp } = manager([server({ directTools: true, disabled: true })]);
  t.after(() => mcp.close());
  assert.deepEqual(await mcp.directTools(), []);
});

test("空闲超时只针对按需的服务器，保持连接的那档不受影响", async (t) => {
  const { manager: mcp, servers } = manager([server({ lifecycle: "keep-alive", idleTimeout: 1 })]);
  t.after(() => mcp.close());
  await mcp.connect("smoke");
  // 直接把「上次使用」推到很久以前，再手动扫一次。
  (mcp as unknown as { lastUsedAt: Map<string, number> }).lastUsedAt.set("smoke", Date.now() - 10 * 60_000);
  (mcp as unknown as { sweepIdleConnections(): void }).sweepIdleConnections();
  assert.equal((await mcp.status()).servers[0]?.status, "connected", "keep-alive 不该被扫掉");

  servers[0] = server({ lifecycle: "lazy", idleTimeout: 1 });
  await mcp.connect("smoke");
  (mcp as unknown as { lastUsedAt: Map<string, number> }).lastUsedAt.set("smoke", Date.now() - 10 * 60_000);
  (mcp as unknown as { sweepIdleConnections(): void }).sweepIdleConnections();
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.equal((await mcp.status()).servers[0]?.status, "not connected");
});

test("没设空闲超时就不会被扫掉", async (t) => {
  const { manager: mcp } = manager([server({ lifecycle: "lazy" })]);
  t.after(() => mcp.close());
  await mcp.connect("smoke");
  (mcp as unknown as { lastUsedAt: Map<string, number> }).lastUsedAt.set("smoke", 0);
  (mcp as unknown as { sweepIdleConnections(): void }).sweepIdleConnections();
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.equal((await mcp.status()).servers[0]?.status, "connected");
});
