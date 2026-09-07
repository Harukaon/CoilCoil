import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { McpCredentialStore, credentialKey, defaultCredentialFile } from "../src/credential-store.ts";
import { McpOAuthProvider } from "../src/oauth-provider.ts";

const SERVER = "https://mcp.example.com/v1";

function provider(): { provider: McpOAuthProvider; store: McpCredentialStore; opened: URL[] } {
  const directory = mkdtempSync(join(tmpdir(), "coilcoil-mcp-oauth-"));
  const store = new McpCredentialStore(defaultCredentialFile(join(directory, "agent")));
  const opened: URL[] = [];
  return {
    store,
    opened,
    provider: new McpOAuthProvider({
      serverUrl: SERVER,
      store,
      redirectUrl: "http://127.0.0.1:7891/callback",
      openAuthorization: (url) => { opened.push(url); },
    }),
  };
}

const tokens = { access_token: "at", refresh_token: "rt", token_type: "Bearer" } as unknown as OAuthTokens;

test("授权信息进的是 CoilCoil 自己的文件，不碰系统钥匙串", () => {
  // 这正是换掉 pi-mcp-adapter 的原因：ad-hoc 签名下每次重新打包，macOS 都把
  // CoilCoil 当成另一个应用，于是每次都弹窗要钥匙串权限。
  const { provider: auth, store } = provider();
  auth.saveTokens(tokens);
  assert.deepEqual(store.get(credentialKey(SERVER))?.tokens, tokens);
  assert.deepEqual(auth.tokens(), tokens);
});

test("客户端元数据里的回调地址和真正用的那一个是同一个", () => {
  // 两处对不上，授权服务器会直接拒掉重定向，而且报的错通常看不出是这个原因。
  const { provider: auth } = provider();
  assert.deepEqual(auth.clientMetadata.redirect_uris, [auth.redirectUrl]);
  assert.equal(auth.clientMetadata.token_endpoint_auth_method, "none");
});

test("state 存下来，浏览器隔一会儿回来也还认得", () => {
  const { provider: auth, store } = provider();
  const first = auth.state();
  assert.equal(auth.state(), first, "同一次授权里 state 必须稳定");
  // 换一个 provider 实例读同一份存储——等于进程重启后继续这次授权。
  const resumed = new McpOAuthProvider({
    serverUrl: SERVER, store, redirectUrl: "http://127.0.0.1:7891/callback", openAuthorization: () => undefined,
  });
  assert.equal(resumed.state(), first);
});

test("换到令牌之后，PKCE 校验码和 state 一起作废", () => {
  const { provider: auth, store } = provider();
  auth.saveCodeVerifier("verifier-1");
  auth.state();
  auth.saveTokens(tokens);
  const record = store.get(credentialKey(SERVER));
  // 留着就等于同一个回调可以被重放到一次已经结束的授权上。
  assert.equal(record?.codeVerifier, undefined);
  assert.equal(record?.state, undefined);
  assert.throws(() => auth.codeVerifier(), /重新发起认证/);
});

test("授权页记下来，失败了还能重新打开", async () => {
  const { provider: auth, opened } = provider();
  const url = new URL("https://auth.example.com/authorize?state=s-1");
  await auth.redirectToAuthorization(url);
  assert.deepEqual(opened, [url]);
  assert.equal(auth.authorizationUrl?.href, url.href);
});

test("服务器说凭据过期了就按范围丢掉", () => {
  const { provider: auth, store } = provider();
  auth.saveClientInformation({ client_id: "abc" } as never);
  auth.saveTokens(tokens);
  auth.saveCodeVerifier("v");

  auth.invalidateCredentials("tokens");
  assert.equal(auth.tokens(), undefined);
  assert.deepEqual(store.get(credentialKey(SERVER))?.clientInformation, { client_id: "abc" });

  auth.invalidateCredentials("verifier");
  assert.equal(store.get(credentialKey(SERVER))?.codeVerifier, undefined);

  auth.invalidateCredentials("client");
  assert.equal(auth.clientInformation(), undefined);
});

test("登出是整条记录一起没，注册信息不留", () => {
  const { provider: auth, store } = provider();
  auth.saveClientInformation({ client_id: "abc" } as never);
  auth.saveTokens(tokens);
  auth.invalidateCredentials("all");
  assert.equal(store.get(credentialKey(SERVER)), undefined);
});

test("两个服务器的凭据互不串门", () => {
  const directory = mkdtempSync(join(tmpdir(), "coilcoil-mcp-oauth-"));
  const store = new McpCredentialStore(defaultCredentialFile(join(directory, "agent")));
  const make = (url: string): McpOAuthProvider => new McpOAuthProvider({
    serverUrl: url, store, redirectUrl: "http://127.0.0.1:7891/callback", openAuthorization: () => undefined,
  });
  const a = make("https://a.example.com/mcp");
  const b = make("https://b.example.com/mcp");
  a.saveTokens(tokens);
  assert.equal(b.tokens(), undefined);
  b.invalidateCredentials("all");
  assert.deepEqual(a.tokens(), tokens);
});
