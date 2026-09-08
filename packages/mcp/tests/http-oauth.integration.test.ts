/**
 * The whole OAuth story against a real authorization server.
 *
 * Everything else in this package is unit-level; this is the test that would
 * have caught the things pi-mcp-adapter got wrong for us. It runs the actual
 * MCP OAuth flow — metadata discovery, dynamic client registration, PKCE, the
 * token exchange, an authorized tool call, logout — against the same fixture
 * the runtime smoke uses, and asserts the two properties that matter most:
 * credentials land in CoilCoil's own file, and nothing needs a Pi session.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfiguration } from "@coilcoil/runtime-protocol";
import { McpAuthCallbackServer } from "../src/auth-callback.ts";
import { McpCredentialStore, credentialKey, defaultCredentialFile } from "../src/credential-store.ts";
import { McpManager } from "../src/manager.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../../../scripts/fixtures/mcp-oauth-smoke-server.mjs");

interface FixtureReady {
  mcpServerUrl: string;
  authServerUrl: string;
  instanceId: string;
}

async function startFixture(): Promise<{ ready: FixtureReady; stop: () => void }> {
  const child: ChildProcess = fork(FIXTURE, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const ready = await new Promise<FixtureReady>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`OAuth fixture did not start. ${stderr}`)), 20_000);
    child.once("message", (message: unknown) => {
      clearTimeout(timer);
      const value = message as { type?: string } & FixtureReady;
      if (value?.type === "ready" && value.mcpServerUrl) resolvePromise(value);
      else rejectPromise(new Error(`OAuth fixture sent an unusable startup message: ${JSON.stringify(message)}`));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`OAuth fixture exited during startup (${code}). ${stderr}`));
    });
  });
  return { ready, stop: () => { child.kill("SIGTERM"); } };
}

function httpServer(name: string, url: string): McpServerConfiguration {
  return {
    name,
    scope: "global",
    transport: "http",
    args: [],
    env: {},
    url,
    headers: {},
    auth: "oauth",
    lifecycle: "lazy",
    exposeResources: false,
    directTools: false,
    excludeTools: [],
    debug: false,
    disabled: false,
    requestTimeoutMs: 20_000,
  } as McpServerConfiguration;
}

/** Play the part of the browser: follow the authorization page's redirect. */
async function approveInBrowser(authorizationUrl: string): Promise<string> {
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  const location = response.headers.get("location");
  assert.ok(
    response.status >= 300 && response.status < 400 && location?.includes("code="),
    `授权页没有给出带 code 的回调：${response.status} ${location}`,
  );
  return location as string;
}

test("HTTP 服务器的整条 OAuth 流程，从头到尾不需要任何会话", { timeout: 90_000 }, async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.stop());

  const directory = mkdtempSync(join(tmpdir(), "coilcoil-mcp-oauth-int-"));
  const credentialFile = defaultCredentialFile(join(directory, "agent"));
  const store = new McpCredentialStore(credentialFile);
  const opened: URL[] = [];
  const definition = httpServer("oauth", fixture.ready.mcpServerUrl);
  const manager = new McpManager({
    loadServers: () => [definition],
    store,
    callback: new McpAuthCallbackServer([0]),
    openAuthorization: (url) => { opened.push(url); },
  });
  t.after(() => manager.close());

  // 1. 没有凭据的时候，检查状态给出的是「需要认证」，而不是一句连接失败。
  const unauthenticated = await manager.connect("oauth");
  assert.equal(unauthenticated.status, "needs-auth");
  assert.equal(manager.failure("oauth"), undefined, "需要认证不是故障，不该带错误信息");
  assert.deepEqual(opened, [], "只是问一句状态，不该把浏览器甩到用户脸上");

  // 2. 明确发起认证才打开浏览器，并且在打开之前就已经架好了回调监听。
  const started = await manager.startAuth("oauth");
  assert.equal(started.error, undefined);
  assert.ok(started.authorizationUrl, "没有拿到授权地址");
  assert.equal(started.awaitingCallback, true, "打开浏览器之前就该架好回调监听");
  assert.equal(opened.length, 1);
  // 刚才那次检查已经把授权页拿到手了，这一步不该再跑一遍握手——远端服务器一个
  // 来回就是好几秒，白跑一遍就是「正在准备授权」卡在那里的原因。
  assert.equal(started.resumed, true);

  // 3. 浏览器回来，回调被监听接住，令牌换到手，连接自己接上。
  const callbackUrl = await approveInBrowser(started.authorizationUrl as string);
  await fetch(callbackUrl);
  const authorized = await manager.awaitAuth("oauth");
  assert.equal(authorized.status, "connected");
  assert.ok(authorized.toolCount >= 1, "认证之后应该发现得到工具");

  // 4. 令牌进的是 CoilCoil 自己的文件——这就是钥匙串弹窗消失的原因。
  const record = store.get(credentialKey(fixture.ready.mcpServerUrl));
  assert.ok(record?.tokens && typeof (record.tokens as { access_token?: string }).access_token === "string");
  assert.ok(record?.clientInformation, "动态注册下来的客户端信息也该留着，下次不用重新注册");
  assert.equal(record?.codeVerifier, undefined, "PKCE 校验码用完就该没了");
  const onDisk = JSON.parse(readFileSync(credentialFile, "utf8")) as { servers: Record<string, unknown> };
  assert.equal(Object.keys(onDisk.servers).length, 1);

  // 5. 带着令牌真的调得动工具。
  const called = await manager.callTool("oauth", (await manager.listTools()).tools[0].tool.name, {}) as {
    content?: Array<{ text?: string }>;
  };
  assert.ok(Array.isArray(called.content), `工具调用没有返回内容：${JSON.stringify(called)}`);

  // 6. 登出之后回到起点：凭据没了，再问就又是「需要认证」。
  await manager.logout("oauth");
  assert.equal(store.get(credentialKey(fixture.ready.mcpServerUrl)), undefined);
  assert.equal((await manager.connect("oauth")).status, "needs-auth");
});

test("没有先检查过的时候，认证自己去把授权页拿回来", { timeout: 90_000 }, async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.stop());
  const directory = mkdtempSync(join(tmpdir(), "coilcoil-mcp-oauth-fresh-"));
  const store = new McpCredentialStore(defaultCredentialFile(join(directory, "agent")));
  const manager = new McpManager({
    loadServers: () => [httpServer("oauth", fixture.ready.mcpServerUrl)],
    store,
    callback: new McpAuthCallbackServer([0]),
    openAuthorization: () => undefined,
  });
  t.after(() => manager.close());

  const started = await manager.startAuth("oauth");
  assert.ok(started.authorizationUrl);
  assert.notEqual(started.resumed, true, "没有可续的东西，就该老老实实握一次手");
});

test("已经连着的服务器，点认证是立刻回答，不是再连一遍", { timeout: 90_000 }, async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.stop());
  const directory = mkdtempSync(join(tmpdir(), "coilcoil-mcp-oauth-done-"));
  const store = new McpCredentialStore(defaultCredentialFile(join(directory, "agent")));
  const manager = new McpManager({
    loadServers: () => [httpServer("oauth", fixture.ready.mcpServerUrl)],
    store,
    callback: new McpAuthCallbackServer([0]),
    openAuthorization: () => undefined,
  });
  t.after(() => manager.close());

  const started = await manager.startAuth("oauth");
  await manager.completeAuth("oauth", await approveInBrowser(started.authorizationUrl as string));
  const again = await manager.startAuth("oauth");
  assert.equal(again.authenticated, true);
  assert.equal(again.authorizationUrl, undefined, "已经认证过就不该再把浏览器打开一次");
});

test("粘贴回调地址这条后路也走得通", { timeout: 90_000 }, async (t) => {
  // 有些授权服务器的回调永远到不了本机监听，粘贴是唯一的出路；卡在最后一步
  // 是最难受的失败方式。
  const fixture = await startFixture();
  t.after(() => fixture.stop());

  const directory = mkdtempSync(join(tmpdir(), "coilcoil-mcp-oauth-paste-"));
  const store = new McpCredentialStore(defaultCredentialFile(join(directory, "agent")));
  const definition = httpServer("oauth", fixture.ready.mcpServerUrl);
  const manager = new McpManager({
    loadServers: () => [definition],
    store,
    callback: new McpAuthCallbackServer([0]),
    openAuthorization: () => undefined,
  });
  t.after(() => manager.close());

  const started = await manager.startAuth("oauth");
  const callbackUrl = await approveInBrowser(started.authorizationUrl as string);
  const completed = await manager.completeAuth("oauth", callbackUrl);
  assert.equal(completed.status, "connected");
});

test("两个不同地址的服务器各自认证，凭据互不影响", { timeout: 90_000 }, async (t) => {
  const first = await startFixture();
  const second = await startFixture();
  t.after(() => { first.stop(); second.stop(); });

  const directory = mkdtempSync(join(tmpdir(), "coilcoil-mcp-oauth-two-"));
  const store = new McpCredentialStore(defaultCredentialFile(join(directory, "agent")));
  const manager = new McpManager({
    loadServers: () => [httpServer("a", first.ready.mcpServerUrl), httpServer("b", second.ready.mcpServerUrl)],
    store,
    callback: new McpAuthCallbackServer([0]),
    openAuthorization: () => undefined,
  });
  t.after(() => manager.close());

  const started = await manager.startAuth("a");
  await manager.completeAuth("a", await approveInBrowser(started.authorizationUrl as string));

  const status = await manager.status();
  assert.equal(status.servers.find((entry) => entry.name === "a")?.status, "connected");
  // b 从没认证过，必须仍然是「需要认证」，不能蹭到 a 的令牌。
  assert.equal((await manager.connect("b")).status, "needs-auth");
  assert.equal(store.get(credentialKey(second.ready.mcpServerUrl))?.tokens, undefined);
});

test("认证到一半取消，不会留下一个占着回调的幽灵", { timeout: 60_000 }, async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.stop());

  const directory = mkdtempSync(join(tmpdir(), "coilcoil-mcp-oauth-cancel-"));
  const store = new McpCredentialStore(defaultCredentialFile(join(directory, "agent")));
  const manager = new McpManager({
    loadServers: () => [httpServer("oauth", fixture.ready.mcpServerUrl)],
    store,
    callback: new McpAuthCallbackServer([0]),
    openAuthorization: () => undefined,
  });
  t.after(() => manager.close());

  const started = await manager.startAuth("oauth");
  assert.equal(started.awaitingCallback, true);
  manager.cancelAuth("oauth");
  await assert.rejects(() => manager.awaitAuth("oauth"), /没有等待中的授权/);
  // 取消之后还能重新来一次，不需要重启应用。
  const restarted = await manager.startAuth("oauth");
  assert.ok(restarted.authorizationUrl);
});
