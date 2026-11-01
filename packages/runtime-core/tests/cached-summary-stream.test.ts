import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { normalizeContext, type Usage } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { CachedSessionRequest } from "@coilcoil/workflow/extensions/anthropic-cache-policy.js";
import { nativeSummaryModel } from "@coilcoil/workflow/extensions/compaction/model.js";
import { summaryPrefix } from "@coilcoil/workflow/extensions/compaction/prefix.js";
import { createStreamRequest } from "@coilcoil/workflow/extensions/compaction/request.js";
import { summarize } from "@coilcoil/workflow/extensions/compaction/summarize.js";
import { installSessionRequestPolicy, sessionCacheLedger } from "../src/session-request-policy.js";
import { syncSubscriptionAccounts, writeSubscriptionAccounts } from "../src/subscription-accounts.js";

interface Payload {
  system: Array<Record<string, unknown>>;
  tools: unknown;
  messages: Array<Record<string, unknown>>;
}

function stripCache(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCache);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "cache_control").map(([key, item]) => [key, stripCache(item)]));
  return value;
}

test("subscription aliases send the main request and cached summary through identical provider transforms", async (t) => {
  const configured = process.env.PI_CACHE_RETENTION;
  delete process.env.PI_CACHE_RETENTION;
  t.after(() => {
    if (configured === undefined) delete process.env.PI_CACHE_RETENTION;
    else process.env.PI_CACHE_RETENTION = configured;
  });
  const root = mkdtempSync(join(tmpdir(), "coil-cache-summary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const account = "claude-cache-test";
  const apiKey = "sk-ant-oat01-offline-cache-test";
  const authPath = join(root, "auth.json");
  writeFileSync(authPath, JSON.stringify({ [account]: { type: "oauth", access: apiKey, refresh: "offline-refresh", expires: Date.now() + 3_600_000 } }));
  writeSubscriptionAccounts(root, [{ id: account, name: "offline", provider: "anthropic" }]);
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  await syncSubscriptionAccounts(runtime, root);
  const registry = new ModelRegistry(runtime);
  const model = registry.find(account, "claude-sonnet-5-5")!;
  const usage: Usage = { input: 4, output: 20, cacheRead: 12_000, cacheWrite: 500, totalTokens: 12_524,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const context = normalizeContext({ systemPrompt: "Stable project instructions", tools: [
    { name: "read", description: "Read files", parameters: { type: "object", properties: {} } },
  ], messages: [
    { role: "user", content: [{ type: "text", text: "Investigate" }], timestamp: 1 },
    { role: "assistant", api: model.api, model: model.id, provider: "anthropic", thinkingLevel: "max",
      content: [{ type: "text", text: "Earlier built-in account response" }], usage, stopReason: "stop", timestamp: 2 },
    { role: "assistant", api: model.api, model: model.id, provider: account, thinkingLevel: "high",
      content: [{ type: "text", text: "Current account response" }], usage, stopReason: "stop", timestamp: 3 },
    { role: "user", content: [{ type: "text", text: "Continue" }], timestamp: 4 },
  ] });
  const bodies: Payload[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${apiKey}`);
    bodies.push(JSON.parse(String(init.body)));
    const cacheOn = bodies.at(-1)!.system.some((block) => block.cache_control !== undefined);
    const event = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
    return new Response(
      event("message_start", { type: "message_start", message: { id: "msg_offline", type: "message", role: "assistant", model: model.id, content: [],
        usage: { input_tokens: cacheOn ? 4 : 1000, output_tokens: 0, cache_read_input_tokens: cacheOn ? 12_000 : 0, cache_creation_input_tokens: cacheOn ? 500 : 0 } } })
      + event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
      + event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "summary" } })
      + event("content_block_stop", { type: "content_block_stop", index: 0 })
      + event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } })
      + event("message_stop", { type: "message_stop" }), { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  let captured: CachedSessionRequest | undefined;
  const agent = new Agent({ streamFn: (selected, transcript, options) => registry.streamSimple(selected, transcript, options) });
  const session = { agent, sessionId: "main" };
  installSessionRequestPolicy(session, runtime, (request) => { captured = request; });
  const main = await agent.streamFunction(model, context, { sessionId: "main", reasoning: "max" });
  const reply = await main.result();
  assert.equal(reply.stopReason, "stop", reply.errorMessage ?? "main request failed");
  assert.equal(captured?.cacheRetention, "long");
  const manager = SessionManager.inMemory(root);
  manager.appendMessage(reply);
  const prefix = summaryPrefix(captured, nativeSummaryModel(model, apiKey), manager.getBranch());
  assert.ok(prefix);
  const send = createStreamRequest({ model, auth: { apiKey }, prefix, stream: registry.streamSimple.bind(registry) });
  const summary = await send({ system: "Write a summary", prompt: "Preserve the ongoing work", maxTokens: 8000, label: "offline" });
  assert.equal(summary.text, "summary");
  assert.equal(bodies.length, 2);
  assert.equal((bodies[0].system.at(-1)!.cache_control as { ttl: string }).ttl, "1h");
  assert.deepEqual(stripCache(bodies[1].system), stripCache(bodies[0].system));
  assert.deepEqual(stripCache(bodies[1].tools), stripCache(bodies[0].tools));
  assert.deepEqual(stripCache(bodies[1].messages.slice(0, bodies[0].messages.length - 1)), stripCache(bodies[0].messages.slice(0, -1)));
  assert.deepEqual(bodies[1].messages.at(-1)?.output_config, { effort: "low" });
  const instructions = bodies[1].messages.flatMap((message) => message.content as Array<Record<string, unknown>>)
    .find((block) => typeof block.text === "string" && block.text.includes("Preserve the ongoing work"));
  assert.ok(instructions);
  assert.equal(instructions.cache_control, undefined, "one-use summary instructions must remain outside cache writes");
  assert.equal(sessionCacheLedger(session)?.requests, 2);
  assert.equal(sessionCacheLedger(session)?.recent.at(-1)?.purpose, "compaction");
  assert.equal(sessionCacheLedger(session)?.recent.at(-1)?.parentPinned, true, "the actual transformed parent request must match");
  assert.equal(sessionCacheLedger(session)?.baseline?.record.responseId, reply.responseId);
  let builds = 0;
  const mismatched = createStreamRequest({ model, auth: { apiKey }, prefix, stream: (selected, transcript, options) => {
    builds++;
    return registry.streamSimple(selected, transcript, { ...options, onPayload: (raw, selectedModel) => {
      const changed = { ...(raw as Record<string, unknown>), system: [{ type: "text", text: "unexpected changed summary system" }] };
      return options?.onPayload?.(changed, selectedModel);
    } });
  } });
  await assert.rejects(mismatched({ system: "Summary", prompt: "One use", maxTokens: 8000, label: "mismatch" }), /prefix mismatch/);
  assert.equal(builds, 1, "a local prefix mismatch must not be retried");
  assert.equal(bodies.length, 2, "a divergent prefix must be rejected before sending an expensive cold request");
  const rerouted = createStreamRequest({ model, auth: { apiKey }, prefix, stream: (selected, transcript, options) =>
    registry.streamSimple(selected, transcript, { ...options, headers: { ...options?.headers, "anthropic-workspace-id": "other-test-workspace" } }) });
  await assert.rejects(rerouted({ system: "Summary", prompt: "One use", maxTokens: 8000, label: "rerouted" }), /prefix mismatch/);
  assert.equal(bodies.length, 2, "actual routing/header changes must also be rejected before HTTP dispatch");
  const cache = captured!.cache!;
  const fallback = await summarize({ units: ["Small independent fallback material"], contextWindow: model.contextWindow,
    modelMaxTokens: model.maxTokens, prefixRequest: mismatched,
    request: createStreamRequest({ model, auth: { apiKey }, cache, stream: registry.streamSimple.bind(registry) }),
  });
  assert.equal(fallback.text, "summary");
  assert.equal(bodies.length, 3, "a mismatch falls back to one independent request");
  assert.equal(sessionCacheLedger(session)?.requests, 3, "cold summary fallbacks must not disappear from accounting");
  assert.equal(sessionCacheLedger(session)?.recent.at(-1)?.outcome, "uncached");
  assert.equal(sessionCacheLedger(session)?.baseline?.record.responseId, reply.responseId);
});
