import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { parseSubscriptionQuota, querySubscriptionQuota } from "../src/provider-quota.js";

const now = Date.UTC(2026, 9, 9, 20);
const claude = { five_hour: { utilization: 0, resets_at: "2026-10-10T01:00:00Z" }, seven_day: { utilization: 74, resets_at: "2026-10-13T00:59:59Z" } };
const codex = { plan_type: "team", rate_limit: {
  primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1791595136 },
  secondary_window: { used_percent: 51, limit_window_seconds: 604800, reset_at: 1791961212 },
} };
const codexToken = `fake.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } })).toString("base64url")}.signature`;
function authRuntime(token = "quota-token") {
  return {
    checkAuth: async () => ({ type: "oauth" as const }),
    getAuth: async () => ({ auth: { apiKey: token }, source: "OAuth" }),
  } as unknown as ModelRuntime;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("Claude uses percentages rather than fractions, preserves genuine zero, and parses ISO resets", () => {
  const result = parseSubscriptionQuota("anthropic", claude, now);
  assert.equal(result.windows[0]?.usedPercent, 0);
  assert.equal(result.windows[1]?.usedPercent, 74);
  assert.equal(result.windows[0]?.resetsAt, Date.UTC(2026, 9, 10, 1));
  assert.equal(result.updatedAt, now);
  assert.equal(parseSubscriptionQuota("anthropic", { five_hour: { utilization: 105 }, seven_day: null }).windows[0]?.usedPercent, 105);
});

test("Codex windows are classified by duration even when reversed or weekly-only", () => {
  const result = parseSubscriptionQuota("openai-codex", { rate_limit: { primary_window: codex.rate_limit.secondary_window, secondary_window: codex.rate_limit.primary_window } }, now);
  assert.deepEqual(result.windows.map((item) => item.usedPercent), [10, 51]);
  assert.equal(result.windows[0]?.resetsAt, 1791595136000);
  const weeklyOnly = parseSubscriptionQuota("openai-codex", { rate_limit: { primary_window: codex.rate_limit.secondary_window } }, now);
  assert.deepEqual(weeklyOnly.windows.map((item) => item.usedPercent), [null, 51]);
});

test("Codex monthly limits are never mislabeled as weekly", () => {
  const result = parseSubscriptionQuota("openai-codex", { rateLimit: { primaryWindow: { usedPercent: "24.5", limitWindowSeconds: "18000", resetAfterSeconds: "120" }, secondaryWindow: { usedPercent: 45, limitWindowSeconds: 30 * 86400 } } }, now);
  assert.equal(result.windows[0]?.usedPercent, 24.5);
  assert.equal(result.windows[0]?.resetsAt, now + 120000);
  assert.equal(result.windows[1]?.usedPercent, null);
  assert.equal(result.windows[2]?.label, "月限制");
});

test("Codex durationless windows remain unclassified, missing/invalid values never become zero", () => {
  const result = parseSubscriptionQuota("openai-codex", { rate_limit: { primary_window: { used_percent: "", reset_at: null }, secondary_window: { used_percent: "90.5", reset_after_seconds: 300 } } }, now);
  assert.equal(result.windows[0]?.usedPercent, null);
  assert.equal(result.windows[0]?.resetsAt, null);
  assert.equal(result.windows[1]?.usedPercent, null);
  assert.equal(result.windows[3]?.usedPercent, 90.5);
  assert.equal(result.windows[3]?.resetsAt, now + 300000);
  assert.match(result.windows[3]!.label, /周期未提供/);
  const missing = parseSubscriptionQuota("anthropic", { five_hour: null, seven_day: { utilization: "not-a-number", resets_at: "invalid" } }, now);
  assert.deepEqual(missing.windows.map((item) => [item.usedPercent, item.resetsAt]), [[null, null], [null, null]]);
  assert.throws(() => parseSubscriptionQuota("anthropic", { error: "wrong body" }));
});

test("optional Claude model limits are additive, not substitutes for the account-wide week", () => {
  const result = parseSubscriptionQuota("anthropic", { ...claude, seven_day_sonnet: { utilization: 25, resets_at: null }, seven_day_opus: null }, now);
  assert.equal(result.windows.length, 3);
  assert.equal(result.windows[1]?.usedPercent, 74);
  assert.equal(result.windows[2]?.label, "Sonnet 周限制");
});

test("quota GET uses official endpoints only and never exposes credentials in its result", async (context) => {
  const calls: Array<{ url: string; headers: Headers; redirect?: RequestRedirect }> = [];
  context.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    calls.push({ url, headers: new Headers(options.headers), redirect: options.redirect });
    return json(url.includes("anthropic") ? claude : codex);
  });
  const a = await querySubscriptionQuota(authRuntime(), "anthropic");
  const b = await querySubscriptionQuota(authRuntime(codexToken), "openai-codex");
  assert.equal(a.status, "ok");
  assert.equal(b.plan, "team");
  assert.equal(calls[0]?.url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(calls[0]?.headers.get("Authorization"), "Bearer quota-token");
  assert.equal(calls[0]?.headers.get("anthropic-beta"), "oauth-2025-04-20");
  assert.equal(calls[1]?.url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(calls[1]?.headers.get("Chatgpt-Account-Id"), "account-test");
  assert.equal(calls[0]?.redirect, "error");
  for (const secret of ["quota-token", codexToken, "account-test"]) assert.ok(!JSON.stringify([a, b]).includes(secret));
});

test("unsupported providers, API keys, absent credentials and auth-switch races never send subscription requests", async (context) => {
  const fetch = context.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  const runtime = authRuntime();
  assert.equal((await querySubscriptionQuota(runtime, "xai")).status, "unsupported");
  context.mock.method(runtime, "checkAuth", async () => ({ type: "api_key" }));
  assert.equal((await querySubscriptionQuota(runtime, "anthropic")).status, "not_logged_in");
  context.mock.method(runtime, "checkAuth", async () => ({ type: "oauth" }));
  context.mock.method(runtime, "getAuth", async () => ({ auth: { apiKey: "api-key-after-switch" }, source: "stored credential" }));
  assert.equal((await querySubscriptionQuota(runtime, "anthropic")).status, "not_logged_in");
  context.mock.method(runtime, "getAuth", async () => undefined);
  assert.equal((await querySubscriptionQuota(runtime, "anthropic")).status, "not_logged_in");
  assert.equal(fetch.mock.callCount(), 0);
});

test("successful requests cache for one minute, explicit refresh bypasses cache, concurrent queries deduplicate", async (context) => {
  const runtime = authRuntime();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetch = context.mock.method(globalThis, "fetch", async () => { await gate; return json(claude); });
  const pending = [querySubscriptionQuota(runtime, "anthropic"), querySubscriptionQuota(runtime, "anthropic", true)];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetch.mock.callCount(), 1);
  release();
  await Promise.all(pending);
  await querySubscriptionQuota(runtime, "anthropic");
  assert.equal(fetch.mock.callCount(), 1);
  await querySubscriptionQuota(runtime, "anthropic", true);
  assert.equal(fetch.mock.callCount(), 2);
});

test("cached quota expires and switching accounts or logging out cannot reuse previous account data", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now });
  const runtime = authRuntime();
  const fetch = context.mock.method(globalThis, "fetch", async () => json(claude));
  await querySubscriptionQuota(runtime, "anthropic");
  context.mock.timers.tick(61000);
  await querySubscriptionQuota(runtime, "anthropic");
  assert.equal(fetch.mock.callCount(), 2);
  context.mock.method(runtime, "getAuth", async () => ({ auth: { apiKey: "other-account" }, source: "OAuth" }));
  await querySubscriptionQuota(runtime, "anthropic");
  assert.equal(fetch.mock.callCount(), 3);
  context.mock.method(runtime, "checkAuth", async () => undefined);
  assert.equal((await querySubscriptionQuota(runtime, "anthropic")).status, "not_logged_in");
  assert.equal(fetch.mock.callCount(), 3);
});

for (const status of [401, 403, 429, 503]) {
  test(`HTTP ${status} cannot erase login or echo an upstream credential-bearing body`, async (context) => {
    const runtime = authRuntime();
    const fetch = context.mock.method(globalThis, "fetch", async () => json({ error: "quota-token private-user-data" }, status));
    const result = await querySubscriptionQuota(runtime, "anthropic");
    assert.equal(result.status, "error");
    assert.ok(!JSON.stringify(result).includes("quota-token"));
    assert.equal((await runtime.checkAuth("anthropic"))?.type, "oauth");
    fetch.mock.restore();
    context.mock.method(globalThis, "fetch", async () => json(claude));
    assert.equal((await querySubscriptionQuota(runtime, "anthropic")).status, "ok");
  });
}

test("network errors, non-JSON and unrecognized payloads are safely retryable", async (context) => {
  const runtime = authRuntime();
  context.mock.method(globalThis, "fetch", async () => { throw new Error("quota-token leaked upstream"); });
  assert.ok(!(await querySubscriptionQuota(runtime, "anthropic")).message?.includes("quota-token"));
  context.mock.method(globalThis, "fetch", async () => new Response("<html>not JSON</html>"));
  assert.equal((await querySubscriptionQuota(runtime, "anthropic")).status, "error");
  context.mock.method(globalThis, "fetch", async () => json({ unknown: true }));
  assert.equal((await querySubscriptionQuota(runtime, "anthropic")).status, "error");
  context.mock.method(globalThis, "fetch", async () => json(claude));
  assert.equal((await querySubscriptionQuota(runtime, "anthropic")).status, "ok");
});

test("quota and credential resolution are bounded by the request timeout", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  context.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  const pending = querySubscriptionQuota(authRuntime(), "anthropic");
  await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.tick(15001);
  const result = await pending;
  assert.equal(result.status, "error");
  assert.match(result.message!, /超时/);
});

test("missing Codex account claims and failing auth cannot leak credentials or make unauthenticated requests", async (context) => {
  const fetch = context.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  assert.equal((await querySubscriptionQuota(authRuntime("invalid-token"), "openai-codex")).status, "error");
  const runtime = authRuntime();
  context.mock.method(runtime, "getAuth", async () => { throw new Error("refresh-secret quota-token"); });
  const result = await querySubscriptionQuota(runtime, "anthropic");
  assert.equal(result.status, "error");
  assert.ok(!JSON.stringify(result).includes("refresh-secret"));
  assert.equal(fetch.mock.callCount(), 0);
});

test("independent file-backed ModelRuntimes refresh an expired OAuth once without another login", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "coil-quota-auth-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "auth.json");
  writeFileSync(path, JSON.stringify({ anthropic: { type: "oauth", access: "expired-test-access", refresh: "fake-refresh", expires: Date.now() - 1000 } }));
  let refreshes = 0;
  const provider = { id: "anthropic", name: "Quota test", baseUrl: "https://api.anthropic.com", models: [], auth: { oauth: {
    name: "Quota test OAuth", isSubscription: true,
    login: async () => { throw new Error("must not login"); },
    refresh: async () => { refreshes++; return { type: "oauth", access: "new-test-access", refresh: "new-fake-refresh", expires: Date.now() + 3600000 }; },
    toAuth: async (credential: { access: string }) => ({ apiKey: credential.access }),
  } } } as unknown as Provider;
  const runtime = await ModelRuntime.create({ authPath: path, modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(provider);
  const otherRuntime = await ModelRuntime.create({ authPath: path, modelsPath: null, refreshOnCreate: false });
  otherRuntime.registerNativeProvider(provider);
  context.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer new-test-access");
    return json(claude);
  });
  const results = await Promise.all([querySubscriptionQuota(runtime, "anthropic"), querySubscriptionQuota(otherRuntime, "anthropic")]);
  assert.ok(results.every((result) => result.status === "ok"));
  assert.equal(refreshes, 1);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).anthropic.refresh, "new-fake-refresh");
});
