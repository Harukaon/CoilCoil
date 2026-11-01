import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CACHED_SESSION_REQUEST, type CachedSessionRequest } from "../extensions/anthropic-cache-policy.ts";
import compactionExtension, { COMPACTION_EVENT } from "../extensions/compaction.ts";
import { summaryPrefix } from "../extensions/compaction/prefix.ts";
import { createStreamRequest } from "../extensions/compaction/request.ts";
import { nativeSummaryModel } from "../extensions/compaction/model.ts";
import { InputTooLongError, summarize } from "../extensions/compaction/summarize.ts";
import { estimateTextTokens } from "../extensions/compaction/text.ts";

const model = anthropicProvider().getModels().find((entry) => entry.id === "claude-sonnet-5-5")!;
const context = normalizeContext({
  systemPrompt: "Stable system prompt",
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
  messages: [{ role: "user", content: [{ type: "text", text: "Investigate the project" }], timestamp: 1 }],
});
const usage: Usage = { input: 4, output: 20, cacheRead: 12_000, cacheWrite: 500, totalTokens: 12_524,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const snapshot = (at = Date.now()): CachedSessionRequest => ({ model, context, at, cacheRetention: "long" });

function sessionWithReply(request: CachedSessionRequest) {
  const manager = SessionManager.inMemory("/tmp/cache-prefix-test");
  manager.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text: "done" }], usage, stopReason: "stop", timestamp: request.at } as AssistantMessage);
  return manager;
}

test("cached summaries require a warm, accepted request from the same account and model", () => {
  const request = snapshot();
  const manager = sessionWithReply(request);
  const entries = manager.getBranch();
  const prefix = summaryPrefix(request, model, entries, request.at + 1000);
  assert.ok(prefix);
  assert.equal(prefix.cacheRetention, "long");
  assert.equal(prefix.context.messages, request.context.messages);
  assert.equal(summaryPrefix(request, model, entries, request.at + 3_600_000), undefined);
  assert.equal(summaryPrefix({ ...request, cacheRetention: "short" }, model, entries, request.at + 300_000), undefined);
  assert.equal(summaryPrefix({ ...request, cacheRetention: "none" }, model, entries), undefined);
  assert.equal(summaryPrefix(request, { ...model, provider: "other-account" }, entries), undefined);
  assert.equal(summaryPrefix(request, { ...model, compat: { ...model.compat, supportsMidConvoEffort: false } }, entries), undefined);
  assert.equal(summaryPrefix(request, { ...model, contextWindow: 16_000 }, entries), undefined);
  manager.appendCompaction("the conversation has already changed", entries[0]!.id, 100_000);
  assert.equal(summaryPrefix(request, model, manager.getBranch()), undefined, "never summarize an old request after compaction");
});

test("subscription aliases inherit native summary capabilities without replacing explicit model settings", () => {
  const alias = { ...model, provider: "claude-personal", compat: undefined };
  assert.equal(nativeSummaryModel(alias, "sk-ant-oat01-offline-test").compat?.supportsMidConvoEffort, true);
  assert.equal(nativeSummaryModel({ ...alias, compat: { supportsMidConvoEffort: false } }, "sk-ant-oat01-offline-test").compat?.supportsMidConvoEffort, false);
  assert.equal(nativeSummaryModel(alias, "offline-api-key"), alias);
});

test("a split turn that compacts the latest reply cannot summarize only the older cached request", () => {
  const request = snapshot();
  const manager = sessionWithReply(request);
  const reply = manager.getBranch().at(-1)!;
  manager.appendMessage({ role: "toolResult", toolCallId: "call_new", toolName: "read",
    content: [{ type: "text", text: "new result absent from the previous request" }], isError: false, timestamp: request.at + 1 });
  const toolResult = manager.getBranch().at(-1)!;
  assert.ok(summaryPrefix(request, model, manager.getBranch(), request.at + 2, reply.id));
  assert.equal(summaryPrefix(request, model, manager.getBranch(), request.at + 2, toolResult.id), undefined);
});

const event = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
function response() {
  return new Response(
    event("message_start", { type: "message_start", message: { id: "msg_offline", role: "assistant", type: "message", model: model.id, content: [],
      usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 12_000, cache_creation_input_tokens: 500,
        cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 } } } })
    + event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
    + event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "交接摘要" } })
    + event("content_block_stop", { type: "content_block_stop", index: 0 })
    + event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } })
    + event("message_stop", { type: "message_stop" }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

function stripCache(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCache);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "cache_control").map(([key, item]) => [key, stripCache(item)]));
  return value;
}

test("the actual Claude summary payload preserves the conversation's tools, system and cached message prefix", async (t) => {
  const bodies: Array<Record<string, any>> = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return response();
  });
  const apiKey = "sk-ant-oat01-offline-test";
  const request = { ...snapshot(), context: normalizeContext({ messages: [
    ...context.messages,
    { role: "assistant", api: model.api, provider: model.provider, model: model.id, thinkingLevel: "high",
      content: [{ type: "thinking", thinking: "Read the evidence", thinkingSignature: "offline-signature" },
        { type: "toolCall", id: "toolu_offline", name: "read", arguments: { path: "src/main.ts" } }],
      usage, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "toolu_offline", toolName: "read", content: [{ type: "text", text: "source code" }], isError: false, timestamp: 3 },
    { role: "assistant", api: model.api, provider: model.provider, model: model.id, thinkingLevel: "high",
      content: [{ type: "text", text: "The source confirms the issue" }], usage, stopReason: "stop", timestamp: 4 },
    { role: "user", content: [{ type: "text", text: "Continue the investigation" }], timestamp: 5 },
  ] }) };
  const main = anthropicProvider().streamSimple(model, request.context, { apiKey, cacheRetention: "long", reasoning: "max" });
  const reply = await main.result();
  assert.equal(reply.stopReason, "stop", reply.errorMessage);
  const prefix = summaryPrefix(request, model, sessionWithReply(request).getBranch());
  assert.ok(prefix);
  const send = createStreamRequest({ model, auth: { apiKey }, prefix });
  const result = await send({ system: "Summarize the conversation; do not use tools", prompt: "Write a handoff", maxTokens: 8000, label: "offline" });
  assert.equal(bodies.length, 2);
  assert.deepEqual(stripCache(bodies[1].tools), stripCache(bodies[0].tools));
  assert.deepEqual(stripCache(bodies[1].system), stripCache(bodies[0].system));
  // The original final effort marker was after the cache breakpoint, so a new summary effort can follow it.
  assert.deepEqual(stripCache(bodies[1].messages.slice(0, bodies[0].messages.length - 1)), stripCache(bodies[0].messages.slice(0, -1)));
  assert.deepEqual(bodies[1].messages.at(-1).output_config, { effort: "low" });
  assert.equal(bodies[1].system[0].cache_control.ttl, "1h");
  assert.equal(result.usage?.cacheRead, 12_000);
  assert.equal(result.usage?.cacheWrite1h, 500);
});

test("permanent request failures are sent once instead of multiplying SDK and summary retries", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "invalid signature" } }), { status: 400 });
  });
  const request = createStreamRequest({ model, auth: { apiKey: "offline-key" }, attempts: 3 });
  await assert.rejects(request({ system: "summarize", prompt: "history", maxTokens: 1000, label: "test" }), /invalid signature/);
  assert.equal(calls, 1);
});

test("the compaction hook receives the captured main request and persists real summary cache usage", async (t) => {
  t.mock.method(globalThis, "fetch", async () => response());
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const listeners = new Map<string, (value: unknown) => void>();
  const progress: Array<Record<string, unknown>> = [];
  compactionExtension({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); },
    events: {
      on: (name: string, handler: (value: unknown) => void) => { listeners.set(name, handler); return () => listeners.delete(name); },
      emit: (name: string, value: Record<string, unknown>) => { if (name === COMPACTION_EVENT) progress.push(value); },
    },
    getActiveTools: () => ["read"], getAllTools: () => [],
  } as never);
  const request = snapshot();
  listeners.get(CACHED_SESSION_REQUEST)!(request);
  const manager = sessionWithReply(request);
  const registry = { find: () => undefined,
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-ant-oat01-offline-test" }),
    streamSimple: anthropicProvider().streamSimple,
  };
  const result = await handlers.get("session_before_compact")!({
    reason: "manual", customInstructions: "Preserve file paths", signal: new AbortController().signal,
    branchEntries: manager.getBranch(), preparation: {
      messagesToSummarize: [{ role: "user", content: "Investigate the project", timestamp: 1 }], turnPrefixMessages: [],
      firstKeptEntryId: manager.getBranch()[0]!.id, tokensBefore: 100_000,
      fileOps: { read: new Set(), edited: new Set(), written: new Set() }, settings: { reserveTokens: 16_384 },
    },
  }, { model, sessionManager: manager, modelRegistry: registry, getSystemPrompt: () => "Stable system prompt" }) as {
    compaction: { summary: string; usage: Usage };
  };
  assert.equal(result.compaction.summary, "交接摘要");
  assert.equal(result.compaction.usage.cacheRead, 12_000);
  assert.equal(result.compaction.usage.cacheWrite1h, 500);
  assert.ok(progress.some((event) => event.phase === "cache_prefix" && event.eligible === true));
});

test("a prefix that cannot fit falls back to the compact text request", async () => {
  const labels: string[] = [];
  const result = await summarize({ units: ["the material"], contextWindow: 200_000, modelMaxTokens: 16_000,
    prefixRequest: async (request) => { labels.push(request.label); throw new InputTooLongError("prompt is too long", usage); },
    request: async (request) => { labels.push(request.label); return { text: "summary", inputTokens: 100, outputTokens: 20 }; },
  });
  assert.deepEqual(labels, ["复用会话缓存", "一次写完"]);
  assert.equal(result.text, "summary");
  assert.equal(result.usage.input, 104);
  assert.equal(result.usage.output, 40);
  assert.equal(result.usage.cacheRead, 12_000, "the failed prefix attempt's usage must survive the fallback");
});

test("split-turn compaction sends facts from the latest reply through the independent summary request", async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return response();
  });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const listeners = new Map<string, (value: unknown) => void>();
  compactionExtension({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
    events: { on: (name: string, handler: (value: unknown) => void) => { listeners.set(name, handler); return () => {}; }, emit: () => {} },
    getActiveTools: () => [], getAllTools: () => [],
  } as never);
  const request = snapshot();
  listeners.get(CACHED_SESSION_REQUEST)!(request);
  const manager = sessionWithReply(request);
  const reply = manager.getBranch().at(-1)! as { message: AssistantMessage };
  reply.message.content = [{ type: "text", text: "NEW_DECISION_ONLY_IN_LATEST_REPLY" }];
  manager.appendMessage({ role: "user", content: "keep this recent message", timestamp: request.at + 1 });
  const result = await handlers.get("session_before_compact")!({
    reason: "manual", customInstructions: "keep every decision", signal: new AbortController().signal,
    branchEntries: manager.getBranch(), preparation: {
      messagesToSummarize: [], turnPrefixMessages: [reply.message], firstKeptEntryId: manager.getBranch().at(-1)!.id,
      tokensBefore: 100_000, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: { reserveTokens: 16_384 },
    },
  }, { model, sessionManager: manager, getSystemPrompt: () => "Stable system prompt", modelRegistry: {
    find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "offline-key" }), streamSimple: anthropicProvider().streamSimple,
  } }) as { compaction?: unknown };
  assert.ok(result.compaction);
  assert.equal(bodies.length, 1);
  assert.match(JSON.stringify(bodies[0].messages), /NEW_DECISION_ONLY_IN_LATEST_REPLY/);
});

test("summary wire requests never exceed the selected model's output limit", async (t) => {
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    assert.equal(JSON.parse(String(init.body)).max_tokens, 1_024);
    return response();
  });
  const request = createStreamRequest({ model: { ...model, maxTokens: 1_024 }, auth: { apiKey: "offline-key" } });
  await request({ system: "summarize", prompt: "history", maxTokens: 16_000, label: "output-cap" });
});

test("a summary chunk cancellation aborts the provider request without retry", async (t) => {
  let called!: () => void;
  const started = new Promise<void>((resolve) => { called = resolve; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    calls++;
    called();
    return await new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
    });
  });
  const controller = new AbortController();
  const request = createStreamRequest({ model, auth: { apiKey: "offline-key" }, attempts: 3 });
  const pending = request({ system: "summarize", prompt: "history", maxTokens: 1_000, label: "cancelled-chunk", signal: controller.signal });
  const failed = assert.rejects(pending, /压缩已取消/);
  await started;
  controller.abort();
  await failed;
  assert.equal(calls, 1);
});

test("an 8k summary window budgets the complete encoded prompt and useful output before the SDK clamp", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init.body)) as {
      system: Array<{ text?: string }>;
      messages: Array<{ content: Array<{ text?: string }> }>;
      max_tokens: number;
    };
    const text = [...body.system, ...body.messages.flatMap((message) => message.content)].map((block) => block.text ?? "").join("");
    const input = Math.max(estimateTextTokens(text), Math.ceil(text.length / 3.5));
    assert.ok(body.max_tokens >= 700, `the SDK reduced this summary to ${body.max_tokens} output tokens`);
    assert.ok(input + body.max_tokens + 4096 <= 8000, `input=${input}, output=${body.max_tokens}`);
    return response();
  });
  const smallModel = { ...model, contextWindow: 8000, maxTokens: 8000, reasoning: false };
  const request = createStreamRequest({ model: smallModel, auth: { apiKey: "offline-key" } });
  const summary = await summarize({ units: ["word ".repeat(3200)], contextWindow: 8000, modelMaxTokens: 8000, request });
  assert.ok(summary.chunks > 1);
  assert.ok(calls > 1);
});

test("a summary window consumed by the SDK reserve fails before any provider request", async () => {
  let calls = 0;
  await assert.rejects(summarize({ units: ["history"], contextWindow: 4096, modelMaxTokens: 2048,
    request: async () => { calls++; return { text: "summary", inputTokens: 1, outputTokens: 1 }; },
  }), /上下文窗口过小/);
  assert.equal(calls, 0);
});
