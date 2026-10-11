import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { normalizeContext, createAssistantMessageEventStream, type AssistantMessage, type AuthInteraction } from "@earendil-works/pi-ai";
import { CoilCoilRuntime } from "../src/index.js";
import { readSubscriptionAccounts, syncSubscriptionAccounts, validateSubscriptionAccount, writeSubscriptionAccounts } from "../src/subscription-accounts.js";
import { subscriptionStream, subscriptionTranscript } from "../src/subscription-stream.js";

const ids = ["claude-work", "claude-personal", "codex-work", "codex-personal"] as const;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function credential(id: string) {
  const codex = id.startsWith("codex") || id === "openai-codex";
  const access = codex ? `e2e.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: `account-${id}` } })).toString("base64url")}.signature` : `sk-ant-oat01-e2e-${id}`;
  return { type: "oauth" as const, access, refresh: `fake-refresh-${id}`, expires: Date.now() + 3600000, ...(codex ? { accountId: `account-${id}` } : {}) };
}
async function setup(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "coil-subscription-accounts-"));
  const agent = join(root, "agent");
  const runtime = new CoilCoilRuntime({ agentDir: agent, sessionDir: join(root, "sessions") });
  const models = await runtime.sharedModelRuntime();
  const path = join(agent, "auth.json");
  writeFileSync(path, JSON.stringify({ anthropic: credential("anthropic"), "openai-codex": credential("openai-codex") }));
  await models.refresh({ allowNetwork: false });
  context.after(async () => { await runtime.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { root, agent, runtime, models, path };
}
async function createFour(runtime: CoilCoilRuntime) {
  for (const id of ids) await runtime.createSubscriptionAccount({ id, provider: id.startsWith("claude") ? "anthropic" : "openai-codex", name: id });
}
async function login(context: TestContext, runtime: CoilCoilRuntime, models: ModelRuntime, id: string) {
  const oauth = models.getRegisteredNativeProvider(id)?.auth.oauth;
  assert.ok(oauth);
  context.mock.method(oauth, "login", async (interaction: AuthInteraction) => {
    const input = await interaction.prompt({ type: "text", message: "Fake account confirmation" });
    assert.equal(input, id);
    return credential(id);
  });
  const started = await runtime.startModelProviderOAuth(id);
  let snapshot = await runtime.getModelProviderOAuth(started.flowId);
  for (let i = 0; i < 8 && !snapshot.state.prompt; i++) snapshot = await runtime.awaitModelProviderOAuth(started.flowId, snapshot.revision, 1000);
  const state = snapshot.state;
  assert.ok(state.prompt);
  await runtime.respondModelProviderOAuth(state.flowId, state.prompt.id, id);
  snapshot = await runtime.getModelProviderOAuth(state.flowId);
  for (let i = 0; i < 8 && snapshot.state.status !== "succeeded"; i++) snapshot = await runtime.awaitModelProviderOAuth(state.flowId, snapshot.revision, 1000);
  assert.equal(snapshot.state.status, "succeeded");
}

test("subscription definitions reject built-in IDs, invalid prefixes/types, duplicates and corrupt files", () => {
  assert.throws(() => validateSubscriptionAccount({ id: "anthropic", provider: "anthropic" }), /内置/);
  assert.throws(() => validateSubscriptionAccount({ id: "../other", provider: "anthropic" }), /前缀/);
  assert.throws(() => validateSubscriptionAccount({ id: "__proto__", provider: "anthropic" }), /前缀/);
  assert.equal(validateSubscriptionAccount({ id: "claude-work", provider: "anthropic" }).name, "claude-work");
  const root = mkdtempSync(join(tmpdir(), "coil-accounts-invalid-"));
  try {
    writeFileSync(join(root, "subscription-accounts.json"), "not JSON");
    assert.throws(() => readSubscriptionAccounts(root), /无法读取/);
    unlinkSync(join(root, "subscription-accounts.json"));
    const a = validateSubscriptionAccount({ id: "work", provider: "anthropic" });
    writeSubscriptionAccounts(root, [a, a]);
    assert.throws(() => readSubscriptionAccounts(root), /重复/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("creating two Claude and two Codex accounts preserves originals, exposes full native models and prevents ID collisions", async (context) => {
  const { runtime, models, path, agent } = await setup(context);
  const original = readFileSync(path, "utf8");
  await createFour(runtime);
  const snapshot = await runtime.getModelProviderConfiguration();
  for (const id of ids) {
    const row = snapshot.providers.find((p) => p.id === id)!;
    assert.equal(row.source, "subscription");
    assert.equal(row.subscriptionProvider, id.startsWith("claude") ? "anthropic" : "openai-codex");
    assert.equal(row.credential.methods.length, 0);
    assert.ok(row.credential.oauth);
    assert.ok(row.models.length > 0);
    assert.ok(row.models.every((m) => !m.id.startsWith(id)));
    assert.equal(models.getRegisteredNativeProvider(id)?.auth.apiKey, undefined);
  }
  assert.equal(readFileSync(path, "utf8"), original);
  assert.ok(!readFileSync(join(agent, "subscription-accounts.json"), "utf8").includes("fake-refresh"));
  await assert.rejects(runtime.createSubscriptionAccount({ id: "claude-work", provider: "openai-codex" }), /已被使用/);
  await assert.rejects(runtime.createSubscriptionAccount({ id: "anthropic", provider: "anthropic" }), /内置/);
  assert.equal(readSubscriptionAccounts(agent).length, 4);
});

test("parallel account creation preserves both additions and does not copy any login", async (context) => {
  const { runtime, agent, path } = await setup(context);
  const original = readFileSync(path, "utf8");
  await Promise.all([runtime.createSubscriptionAccount({ id: "claude-a", provider: "anthropic" }), runtime.createSubscriptionAccount({ id: "claude-b", provider: "anthropic" })]);
  assert.deepEqual(readSubscriptionAccounts(agent).map((a) => a.id).sort(), ["claude-a", "claude-b"]);
  assert.equal(readFileSync(path, "utf8"), original);
});

test("actual login pipeline saves six independent credentials and account-specific quota caches", async (context) => {
  const { runtime, models, path } = await setup(context);
  const original = JSON.parse(readFileSync(path, "utf8"));
  await createFour(runtime);
  for (const id of ids) await login(context, runtime, models, id);
  const stored = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(Object.keys(stored).length, 6);
  assert.deepEqual(stored.anthropic, original.anthropic);
  assert.deepEqual(stored["openai-codex"], original["openai-codex"]);
  for (const id of ids) assert.equal(stored[id].access, credential(id).access);
  const calls: string[] = [];
  context.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    const headers = new Headers(options.headers);
    const id = ids.find((id) => headers.get("Authorization") === `Bearer ${credential(id).access}`)!;
    assert.ok(id);
    calls.push(id);
    const used = ids.indexOf(id) * 10 + 5;
    const payload = id.startsWith("claude") ? { five_hour: { utilization: used, resets_at: null }, seven_day: { utilization: used + 10, resets_at: null } } : { rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 18000 }, secondary_window: { used_percent: used + 10, limit_window_seconds: 604800 } } };
    assert.equal(url, id.startsWith("claude") ? "https://api.anthropic.com/api/oauth/usage" : "https://chatgpt.com/backend-api/wham/usage");
    if (id.startsWith("codex")) assert.equal(headers.get("Chatgpt-Account-Id"), `account-${id}`);
    return new Response(JSON.stringify(payload));
  });
  for (const id of ids) {
    const q = await runtime.getModelProviderQuota(id);
    assert.equal(q.status, "ok");
    assert.equal(q.provider, id);
    assert.equal(q.windows[0]?.usedPercent, ids.indexOf(id) * 10 + 5);
    assert.ok(!JSON.stringify(q).includes(stored[id].access));
    await runtime.getModelProviderQuota(id);
  }
  assert.deepEqual(calls, [...ids]);
  const config = await runtime.getConfiguration();
  for (const id of ids) assert.ok(config.models.filter((m) => m.provider === id).every((m) => m.name.startsWith(`${id} · `)));
});

test("restart restores account models and credentials, while name/disabled overrides remain scoped", async (context) => {
  const { agent, runtime, models, path } = await setup(context);
  await createFour(runtime);
  for (const id of ids) await login(context, runtime, models, id);
  await runtime.saveModelProviderPatch({ id: "claude-work", name: "我的工作账号", disabled: true });
  const restored = await ModelRuntime.create({ authPath: path, modelsPath: join(agent, "models.json"), refreshOnCreate: false });
  await syncSubscriptionAccounts(restored, agent);
  assert.equal((await restored.getAuth("codex-personal"))?.auth.apiKey, credential("codex-personal").access);
  assert.equal(restored.getProvider("claude-work")?.name, "我的工作账号");
  const config = await runtime.getConfiguration();
  assert.ok(!config.configuredProviders.includes("claude-work"));
  assert.ok(config.configuredProviders.includes("claude-personal"));
  assert.ok(!config.models.some((m) => m.provider === "claude-work"));
});

test("logout and removal affect only the selected account, not originals or siblings", async (context) => {
  const { runtime, models, path, agent } = await setup(context);
  await createFour(runtime);
  for (const id of ids) await login(context, runtime, models, id);
  const before = JSON.parse(readFileSync(path, "utf8"));
  await runtime.removeProviderAuth("claude-work");
  let after = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(after["claude-work"], undefined);
  for (const id of ["anthropic", "openai-codex", "claude-personal", "codex-work", "codex-personal"]) assert.deepEqual(after[id], before[id]);
  assert.ok(readSubscriptionAccounts(agent).some((a) => a.id === "claude-work"));
  await runtime.removeModelProviderConfiguration("codex-work");
  after = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(after["codex-work"], undefined);
  assert.ok(!readSubscriptionAccounts(agent).some((a) => a.id === "codex-work"));
  assert.equal(models.getProvider("codex-work"), undefined);
  assert.deepEqual(after["codex-personal"], before["codex-personal"]);
  await assert.rejects(runtime.createSubscriptionAccount({ id: "codex-work", provider: "openai-codex" }), /旧会话/);
  await assert.rejects(runtime.saveModelProviderPatch({ id: "codex-work", baseUrl: "https://example.invalid", api: "openai-responses", models: [{ id: "test" }] }), /旧会话/);
});

test("removing an account cancels its pending authorization rather than resurrecting it afterward", async (context) => {
  const { runtime, models, path } = await setup(context);
  await runtime.createSubscriptionAccount({ id: "pending-account", provider: "anthropic" });
  const oauth = models.getRegisteredNativeProvider("pending-account")!.auth.oauth!;
  context.mock.method(oauth, "login", async (interaction: AuthInteraction) => {
    await interaction.prompt({ type: "text", message: "Pending account" });
    return credential("pending-account");
  });
  const state = await runtime.startModelProviderOAuth("pending-account");
  await runtime.removeModelProviderConfiguration("pending-account");
  assert.equal((await runtime.getModelProviderOAuth(state.flowId)).state.status, "cancelled");
  assert.equal(JSON.parse(readFileSync(path, "utf8"))["pending-account"], undefined);
});

test("expired sibling accounts each refresh their own credential without changing originals", async (context) => {
  const { runtime, models, path } = await setup(context);
  await createFour(runtime);
  for (const id of ids) await login(context, runtime, models, id);
  const stored = JSON.parse(readFileSync(path, "utf8"));
  const original = JSON.stringify([stored.anthropic, stored["openai-codex"]]);
  for (const id of ids) stored[id].expires = Date.now() - 1000;
  writeFileSync(path, JSON.stringify(stored));
  const refreshes: string[] = [];
  for (const id of ids) {
    context.mock.method(models.getRegisteredNativeProvider(id)!.auth.oauth!, "refresh", async (current: { refresh: string }) => {
      assert.equal(current.refresh, `fake-refresh-${id}`);
      refreshes.push(id);
      return { ...credential(id), refresh: `renewed-${id}` };
    });
  }
  await Promise.all(ids.flatMap((id) => [models.getAuth(id), models.getAuth(id)]));
  const renewed = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(refreshes.sort(), [...ids].sort());
  assert.equal(JSON.stringify([renewed.anthropic, renewed["openai-codex"]]), original);
  for (const id of ids) assert.equal(renewed[id].refresh, `renewed-${id}`);
});

test("stream bridge preserves account metadata without mutating the native cached output or other-account history", async () => {
  const message: AssistantMessage = { role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: "test", content: [{ type: "text", text: "ok" }], usage, stopReason: "stop", timestamp: 0 };
  const source = createAssistantMessageEventStream();
  const model = { api: message.api, id: message.model } as ReturnType<ModelRuntime["getModel"]>;
  const output = subscriptionStream(source, "codex-work", model!);
  source.push({ type: "start", partial: message });
  source.push({ type: "done", reason: "stop", message });
  source.end(message);
  const events = [];
  for await (const event of output) events.push(event);
  assert.equal((await output.result()).provider, "codex-work");
  assert.equal(message.provider, "openai-codex");
  assert.equal(events[0]?.type === "start" ? events[0].partial.provider : undefined, "codex-work");
  const own = { ...message, provider: "codex-work" };
  const foreign = { ...message, provider: "codex-personal" };
  const input = normalizeContext({ messages: [own, foreign] });
  const native = subscriptionTranscript(input, "codex-work", "openai-codex");
  assert.equal(native.messages[0]?.role === "assistant" ? native.messages[0].provider : undefined, "openai-codex");
  assert.equal(native.messages[1]?.role === "assistant" ? native.messages[1].provider : undefined, "codex-personal");
  assert.equal(own.provider, "codex-work");
});
