import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { normalizeContext, type Api, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { installSessionRequestPolicy, sessionCacheLedger } from "../src/session-request-policy.js";
import { CACHE_LEDGER_ENTRY, PromptCacheLedger } from "@coilcoil/workflow/extensions/cache/ledger.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CachedSessionRequest } from "@coilcoil/workflow/extensions/anthropic-cache-policy.js";

test("Claude subscription policy reaches Pi's stream wrapper and follows account changes", (t) => {
  const configured = process.env.PI_CACHE_RETENTION;
  delete process.env.PI_CACHE_RETENTION;
  t.after(() => {
    if (configured === undefined) delete process.env.PI_CACHE_RETENTION;
    else process.env.PI_CACHE_RETENTION = configured;
  });
  let subscription = true;
  let captured: SimpleStreamOptions | undefined;
  let lastRequest: CachedSessionRequest | undefined;
  const agent = new Agent({ streamFn: (_model, _context, options) => {
    captured = options;
    throw new Error("captured before provider");
  } });
  const model = { provider: "claude-personal", api: "anthropic-messages" } as Model<Api>;
  const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });
  installSessionRequestPolicy({ agent, sessionId: "main-session" }, { isUsingSubscription: () => subscription }, (request) => { lastRequest = request; });
  const capture = (options?: SimpleStreamOptions, selected = model) => {
    assert.throws(() => agent.streamFunction(selected, context, { sessionId: "main-session", ...options }), /captured before provider/);
    return captured;
  };
  const configuredRequest = capture({ reasoning: "max" });
  assert.equal(configuredRequest?.sessionId, "main-session");
  assert.equal(configuredRequest?.reasoning, "max");
  assert.equal(configuredRequest?.cacheRetention, "long");
  assert.equal(lastRequest?.cacheRetention, "long");
  assert.notEqual(lastRequest?.context.messages, context.messages, "later array appends must not change the captured prefix");
  const mainRequest = lastRequest;
  assert.equal(capture({ sessionId: "branch-summary" })?.cacheRetention, undefined);
  assert.equal(lastRequest, mainRequest, "a branch summary must not overwrite the main conversation prefix");
  for (const cacheRetention of ["none", "short", "long"] as const) {
    assert.equal(capture({ cacheRetention })?.cacheRetention, cacheRetention);
  }
  assert.equal(capture({ env: { PI_CACHE_RETENTION: "short" } })?.cacheRetention, "short");
  subscription = false;
  assert.equal(capture()?.cacheRetention, undefined, "API keys must keep the provider's default");
  assert.equal(capture({ env: { PI_CACHE_RETENTION: "long" } })?.cacheRetention, "long");
  subscription = true;
  assert.equal(capture({}, { ...model, api: "openai-codex-responses" })?.cacheRetention, undefined);
});

test("rewinding merges a repeated cache boundary using its latest refresh time", () => {
  const agent = new Agent({ streamFn: () => { throw new Error("intercepted"); } });
  let entries = [{ id: "first", type: "label", targetId: "first", label: "first" }] as SessionEntry[];
  const session = { agent, sessionId: "session", sessionManager: { getBranch: () => entries } };
  installSessionRequestPolicy(session as Parameters<typeof installSessionRequestPolicy>[0], { isUsingSubscription: () => false });
  const model = { provider: "anthropic", id: "test", api: "anthropic-messages" } as Model<Api>;
  const context = normalizeContext({ messages: [] });
  const request = () => agent.streamFunction(model, context, { sessionId: "session" });
  assert.throws(request, /intercepted/);
  const point = { hash: "same-boundary", at: 1000, ttl: 300_000, message: 0, block: 0, tokens: 4000 };
  sessionCacheLedger(session)!.points = [point];
  const restored = new PromptCacheLedger().state;
  restored.points = [{ ...point, at: 2000 }];
  entries = [{ id: "rewound", type: "custom", customType: CACHE_LEDGER_ENTRY, data: restored }] as SessionEntry[];
  assert.throws(request, /intercepted/);
  assert.deepEqual(sessionCacheLedger(session)!.points, [{ ...point, at: 2000 }]);
});
