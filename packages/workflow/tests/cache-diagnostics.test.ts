import assert from "node:assert/strict";
import test from "node:test";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { AnthropicCacheController } from "../extensions/cache/controller.ts";
import { object } from "../extensions/cache/wire.ts";

const model = anthropicProvider().getModels().find((entry) => entry.id === "claude-sonnet-5-5")!;
const body = { model: model.id, system: "project", messages: [{ role: "user", content: "question" }] };

async function acceptParent(cache: AnthropicCacheController, headers: Record<string, string>) {
  const prepared = cache.options(model, { cacheRetention: "short", fetch: async () => new Response("ok") }, "conversation");
  const payload = await prepared.options.onPayload!(body, model);
  await prepared.options.fetch!(model.baseUrl, { headers, body: JSON.stringify(payload) });
  const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), stopReason: "stop", content: [], responseId: "accepted-parent",
    usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 10_000, totalTokens: 10_001,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const source = createAssistantMessageEventStream();
  source.push({ type: "done", reason: "stop", message });
  await cache.observe(source, prepared.pending, "conversation").result();
}

const summaryBody = () => ({ ...body, messages: [...body.messages, { role: "user", content: "summarize" }] });

test("diagnostics incompatibility retries only rejected optional fields, then stays disabled", async () => {
  const sent: Record<string, unknown>[] = [];
  const cache = new AnthropicCacheController();
  const prepare = () => cache.options(model, { fetch: async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return sent.length === 1 ? new Response('{"error":{"message":"diagnostics: Extra inputs are not permitted"}}', { status: 400 }) : new Response("ok");
  } }, "conversation", { diagnostics: true });
  const first = prepare();
  const payload = await first.options.onPayload!(body, model);
  assert.ok(object(payload) && payload.diagnostics);
  const response = await first.options.fetch!("https://api.anthropic.com/v1/messages", { body: JSON.stringify(payload) });
  assert.equal(response.status, 200);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].diagnostics, undefined);
  const second = prepare();
  const next = await second.options.onPayload!(body, model);
  assert.ok(object(next));
  assert.equal(next.diagnostics, undefined);
});

test("ordinary 400, auth and network failures are never replayed by diagnostics fallback", async () => {
  for (const [status, error] of [[400, "invalid tool schema"], [401, "diagnostics unauthorized"], [429, "diagnostics unsupported"]] as const) {
    let calls = 0;
    const cache = new AnthropicCacheController();
    const prepared = cache.options(model, { fetch: async () => { calls++; return new Response(error, { status }); } }, "conversation");
    const response = await prepared.options.fetch!(model.baseUrl, { body: JSON.stringify({ ...body, diagnostics: {} }) });
    assert.equal(response.status, status);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const cache = new AnthropicCacheController();
  const prepared = cache.options(model, { fetch: async () => { calls++; throw new Error("offline connection failure"); } }, "conversation");
  await assert.rejects(prepared.options.fetch!(model.baseUrl, { body: JSON.stringify({ ...body, diagnostics: {} }) }), /offline connection failure/);
  assert.equal(calls, 1);
});

test("custom endpoints retain their fetch and hooks, without assuming official diagnostic support", async () => {
  let hook = false;
  const fetch = async () => new Response("ok");
  const cache = new AnthropicCacheController();
  const custom = { ...model, baseUrl: "https://custom.invalid" };
  const prepared = cache.options(custom, { fetch, onPayload: () => { hook = true; return { ...body, system: "hook instructions" }; } }, "conversation");
  const result = await prepared.options.onPayload!(body, custom);
  assert.equal(hook, true);
  assert.equal((await prepared.options.fetch!(custom.baseUrl)).status, 200, "custom fetch remains the actual transport");
  assert.ok(object(result));
  assert.equal(result.diagnostics, undefined);
  assert.match(JSON.stringify(result.system), /hook instructions/);
});

test("diagnostics is opt-in, and cache age starts at dispatch instead of delayed first-token arrival", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const cache = new AnthropicCacheController();
  const prepared = cache.options(model, { fetch: async () => new Response("ok") }, "conversation");
  const payload = await prepared.options.onPayload!(body, model);
  assert.ok(object(payload));
  assert.equal(payload.diagnostics, undefined, "an unverified auth route must not receive new optional fields by default");
  now = 2000;
  await prepared.options.fetch!(model.baseUrl, { body: JSON.stringify(payload) });
  now = 200_000;
  await prepared.options.onProviderStreamEvent!({ type: "message_start", message: { diagnostics: null } }, model);
  assert.equal(prepared.pending.startedAt, 2000, "prefill latency is part of the cache lifetime");
});

test("a summary cannot mistake an older warm sub-prefix for the latest full parent boundary", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const cache = new AnthropicCacheController();
  const first = cache.options(model, { cacheRetention: "long" }, "conversation");
  await first.options.onPayload!(body, model);
  cache.ledger.complete(first.pending.plan!, "conversation", { cacheWrite: 10_000 }, "first", undefined, now);
  now = 1000;
  const nextBody = { ...body, messages: [...body.messages, { role: "assistant", content: "response" }, { role: "user", content: "continue" }] };
  const next = cache.options(model, { cacheRetention: "long" }, "conversation");
  await next.options.onPayload!(nextBody, model);
  cache.ledger.complete(next.pending.plan!, "conversation", { cacheRead: 10_000, cacheWrite: 100 }, "second", undefined, now);
  now = 3_600_500;
  cache.ledger.state.points[0].at = now - 100;
  const summary = cache.options(model, { cacheRetention: "long" }, "compaction", { requireParent: true });
  await assert.rejects(Promise.resolve(summary.options.onPayload!({ ...nextBody,
    messages: [...nextBody.messages, { role: "user", content: "summarize" }] }, model)), /prefix mismatch/);
});

test("provider capability limits and explicit environment policy survive breakpoint planning", async () => {
  const cache = new AnthropicCacheController();
  const limited = { ...model, compat: { ...model.compat, supportsLongCacheRetention: false, supportsCacheControlOnTools: false } };
  const input = { ...body, tools: [{ name: "read", input_schema: { type: "object" } }] };
  const prepared = cache.options(limited, { cacheRetention: "long" }, "conversation");
  assert.equal(prepared.options.cacheRetention, "short");
  const value = await prepared.options.onPayload!(input, limited);
  assert.ok(object(value));
  assert.doesNotMatch(JSON.stringify(value), /"ttl":"1h"/);
  assert.doesNotMatch(JSON.stringify(value.tools), /cache_control/);
  const disabled = cache.options(model, { env: { PI_CACHE_RETENTION: "none" } }, "conversation");
  const off = await disabled.options.onPayload!(input, model);
  assert.equal(disabled.options.cacheRetention, "none");
  assert.doesNotMatch(JSON.stringify(off), /cache_control/);
});

test("the actual SDK completes one billed response after rejecting diagnostics, and preserves its stream", async () => {
  const cache = new AnthropicCacheController();
  const sent: Record<string, unknown>[] = [];
  const prepared = cache.options(model, { apiKey: "offline-diagnostics-key", maxRetries: 0, fetch: async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    if (sent.length === 1) return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"diagnostics: extra field not permitted"}}', { status: 400 });
    const event = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
    return new Response(event("message_start", { type: "message_start", message: { id: "msg_diagnostic_test", role: "assistant", type: "message", model: model.id,
      content: [], usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 10000, cache_read_input_tokens: 0 } } })
      + event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
      + event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "offline success" } })
      + event("content_block_stop", { type: "content_block_stop", index: 0 })
      + event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })
      + event("message_stop", { type: "message_stop" }), { headers: { "Content-Type": "text/event-stream" } });
  } }, "conversation", { diagnostics: true });
  const source = streamSimple(model, { systemPrompt: "stable", messages: [{ role: "user", content: "question", timestamp: 1 }] }, prepared.options);
  const output = cache.observe(source, prepared.pending, "conversation");
  const events: string[] = [];
  for await (const event of output) events.push(event.type);
  const reply = await output.result();
  assert.equal(reply.stopReason, "stop", reply.errorMessage);
  assert.deepEqual(reply.content, [{ type: "text", text: "offline success" }]);
  assert.ok(events.includes("text_delta"));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].diagnostics, undefined);
  assert.equal(cache.ledger.state.requests, 1);
  assert.equal(cache.ledger.state.write, 10000);
});

test("shared summary checks expiration again at dispatch and after SDK backoff", async (t) => {
  for (const delayedRetry of [false, true]) {
    let now = 1000;
    t.mock.method(Date, "now", () => now);
    const cache = new AnthropicCacheController();
    const headers = { "x-api-key": "offline-old-workspace" };
    await acceptParent(cache, headers);
    let calls = 0;
    const summary = cache.options(model, { cacheRetention: "short", fetch: async () => {
      calls++;
      return new Response("rate limited", { status: 429 });
    } }, "compaction", { requireParent: true });
    now = 2000;
    const payload = await summary.options.onPayload!(summaryBody(), model);
    if (delayedRetry) await summary.options.fetch!(model.baseUrl, { headers, body: JSON.stringify(payload) });
    now = 301_001;
    await assert.rejects(summary.options.fetch!(model.baseUrl, { headers, body: JSON.stringify(payload) }), /prefix mismatch/);
    assert.equal(calls, delayedRetry ? 1 : 0, "an expired full history never reaches the transport");
  }
});

test("diagnostics fallback also rechecks a parent that expired during the rejected request", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const cache = new AnthropicCacheController();
  const headers = { "x-api-key": "offline-workspace" };
  await acceptParent(cache, headers);
  let calls = 0;
  const summary = cache.options(model, { cacheRetention: "short", fetch: async () => {
    calls++;
    now = 301_001;
    return new Response('{"error":"diagnostics: extra field not permitted"}', { status: 400 });
  } }, "compaction", { requireParent: true, diagnostics: true });
  const payload = await summary.options.onPayload!(summaryBody(), model);
  await assert.rejects(summary.options.fetch!(model.baseUrl, { headers, body: JSON.stringify(payload) }), /prefix mismatch/);
  assert.equal(calls, 1);
});

test("a newer main request invalidates a summary prepared against the previous full parent", async () => {
  const cache = new AnthropicCacheController();
  const headers = { "x-api-key": "offline-workspace" };
  await acceptParent(cache, headers);
  let calls = 0;
  const summary = cache.options(model, { cacheRetention: "short", fetch: async () => { calls++; return new Response("ok"); } },
    "compaction", { requireParent: true });
  const payload = await summary.options.onPayload!(summaryBody(), model);
  const newer = cache.options(model, { cacheRetention: "short" }, "conversation");
  await newer.options.onPayload!({ ...body, messages: [...body.messages, { role: "user", content: "new work" }] }, model);
  cache.ledger.complete(newer.pending.plan!, "conversation", { cacheRead: 10_000, cacheWrite: 1000 }, "newer");
  await assert.rejects(summary.options.fetch!(model.baseUrl, { headers, body: JSON.stringify(payload) }), /prefix mismatch/);
  assert.equal(calls, 0);
});

test("API key replacement rejects parent sharing; an OAuth refresh within the same account preserves it", async () => {
  for (const oauth of [false, true]) {
    const cache = new AnthropicCacheController();
    const headers = oauth ? { authorization: "Bearer sk-ant-oat01-old" } : { "x-api-key": "offline-workspace-one" };
    await acceptParent(cache, headers);
    let calls = 0;
    const summary = cache.options(model, { cacheRetention: "short", fetch: async () => { calls++; return new Response("ok"); } },
      "compaction", { requireParent: true });
    const payload = await summary.options.onPayload!(summaryBody(), model);
    const replacement = oauth ? { authorization: "Bearer sk-ant-oat01-refreshed" } : { "x-api-key": "offline-workspace-two" };
    const request = summary.options.fetch!(model.baseUrl, { headers: replacement, body: JSON.stringify(payload) });
    if (oauth) assert.equal((await request).status, 200);
    else await assert.rejects(request, /prefix mismatch: summary credentials/);
    assert.equal(calls, oauth ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(cache.ledger.state), /offline-workspace|sk-ant-oat|credential/);
  }
});

test("diagnostics opt-in belongs to the prepared request even if another account is prepared concurrently", async () => {
  const cache = new AnthropicCacheController();
  const subscription = cache.options(model, undefined, "conversation", { diagnostics: false });
  const api = cache.options(model, undefined, "conversation", { diagnostics: true });
  const subscriptionBody = await subscription.options.onPayload!(body, model);
  const apiBody = await api.options.onPayload!(body, model);
  assert.ok(object(subscriptionBody) && object(apiBody));
  assert.equal(subscriptionBody.diagnostics, undefined);
  assert.ok(apiBody.diagnostics);
});
