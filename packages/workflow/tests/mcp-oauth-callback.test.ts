import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizationRedirectInput,
  oauthStateFromAuthorizationUrl,
} from "../extensions/mcp-adapter.ts";

test("授权地址里的 state 就是本地回调服务器的等待键", () => {
  assert.equal(
    oauthStateFromAuthorizationUrl("https://auth.example.com/authorize?client_id=abc&state=s-123&scope=mcp"),
    "s-123",
  );
  // The loopback listener refuses a callback without a state, so a URL that
  // carries none must not be treated as capturable.
  assert.equal(oauthStateFromAuthorizationUrl("https://auth.example.com/authorize?client_id=abc"), undefined);
  assert.equal(oauthStateFromAuthorizationUrl("https://auth.example.com/authorize?state=%20"), undefined);
  assert.equal(oauthStateFromAuthorizationUrl("not a url"), undefined);
  assert.equal(oauthStateFromAuthorizationUrl(undefined), undefined);
  assert.equal(oauthStateFromAuthorizationUrl(42), undefined);
});

test("捕获到的回调按 auth-complete 期待的形状回传", () => {
  assert.equal(
    authorizationRedirectInput({ code: "code-1" }, "s-123"),
    "?code=code-1&state=s-123",
  );
  assert.equal(
    authorizationRedirectInput({ code: "code-1", iss: "https://auth.example.com" }, "s-123"),
    "?code=code-1&state=s-123&iss=https%3A%2F%2Fauth.example.com",
  );
});

test("回传串能被标准 URL 解析还原出授权码", () => {
  const input = authorizationRedirectInput({ code: "a/b+c=", iss: "https://auth.example.com" }, "s 123");
  const params = new URLSearchParams(input.slice(1));
  assert.equal(params.get("code"), "a/b+c=");
  assert.equal(params.get("state"), "s 123");
  assert.equal(params.get("iss"), "https://auth.example.com");
});

/**
 * The bug this file exists for.
 *
 * pi's `auth-start` only reserves the flow's state on its loopback listener;
 * nothing waits for the redirect. The browser therefore lands on "copy this URL
 * back into Pi" and the authorization code is discarded — which is exactly what
 * "浏览器登录后没有回调回去" looked like. Registering a waiter on the same
 * module singleton, the way the MCP adapter extension now does, turns the same
 * redirect into a captured code.
 */
test("回调服务器只有挂了等待者才会把授权码交出来", async () => {
  const { createJiti } = await import("jiti");
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");

  // One jiti instance, the same arrangement the extension uses: whatever pi's
  // own modules import must be the very object loaded here.
  const jiti = createJiti(import.meta.url);
  const adapterDirectory = dirname(createRequire(import.meta.url).resolve("pi-mcp-adapter"));
  const callbackServer = jiti(join(adapterDirectory, "mcp-callback-server.ts")) as {
    ensureCallbackServer: (options: Record<string, unknown>) => Promise<void>;
    waitForCallback: (state: string) => Promise<{ code: string; iss?: string }>;
    stopCallbackServer: () => Promise<void>;
  };
  const oauthProvider = jiti(join(adapterDirectory, "mcp-oauth-provider.ts")) as {
    getOAuthCallbackPort: () => number;
    getOAuthCallbackPath: () => string;
  };

  try {
    await callbackServer.ensureCallbackServer({ oauthState: "state-a", reserveState: true });
    const endpoint = `http://localhost:${oauthProvider.getOAuthCallbackPort()}${oauthProvider.getOAuthCallbackPath()}`;

    const dropped = await fetch(`${endpoint}?code=code-a&state=state-a`);
    assert.equal(dropped.status, 200);
    assert.match(await dropped.text(), /paste it back into Pi/);

    await callbackServer.ensureCallbackServer({ oauthState: "state-b", reserveState: true });
    const captured = callbackServer.waitForCallback("state-b");
    const accepted = await fetch(`${endpoint}?code=code-b&state=state-b&iss=${encodeURIComponent("https://auth.example.com")}`);
    assert.equal(accepted.status, 200);
    assert.match(await accepted.text(), /Authorization Successful/);
    assert.deepEqual(await captured, { code: "code-b", iss: "https://auth.example.com" });
  } finally {
    await callbackServer.stopCallbackServer();
  }
});

test("直接加载的回调服务器就是 pi 的 OAuth 流程用的那一个", async () => {
  const { createJiti } = await import("jiti");
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");

  const jiti = createJiti(import.meta.url);
  const adapterDirectory = dirname(createRequire(import.meta.url).resolve("pi-mcp-adapter"));
  const callbackServer = jiti(join(adapterDirectory, "mcp-callback-server.ts")) as {
    ensureCallbackServer: (options: Record<string, unknown>) => Promise<void>;
    isCallbackServerRunning: () => boolean;
    stopCallbackServer: () => Promise<void>;
  };
  const authFlow = jiti(join(adapterDirectory, "mcp-auth-flow.ts")) as {
    shutdownOAuth: () => Promise<void>;
  };

  try {
    await callbackServer.ensureCallbackServer({});
    assert.equal(callbackServer.isCallbackServerRunning(), true);
    // shutdownOAuth() closes the listener through mcp-auth-flow's own import.
    // Seeing it here proves both files resolve to a single module instance,
    // which is what lets the extension claim pi's pending callbacks at all.
    await authFlow.shutdownOAuth();
    assert.equal(callbackServer.isCallbackServerRunning(), false);
  } finally {
    await callbackServer.stopCallbackServer();
  }
});
