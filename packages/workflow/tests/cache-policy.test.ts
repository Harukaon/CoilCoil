import assert from "node:assert/strict";
import test from "node:test";
import { planCache, type WireObject, object } from "../extensions/cache/wire.ts";
import { CACHE_LEDGER_ENTRY, cacheLedgerCheckpoint, PromptCacheLedger, restoreCacheLedger } from "../extensions/cache/ledger.ts";

const control = { type: "ephemeral", ttl: "1h" };
const payload = () => ({ model: "claude-sonnet-5-5", tools: [{ name: "read", input_schema: {
  type: "object", properties: { cache_control: { type: "string" } } }, cache_control: control }],
system: [{ type: "text", text: "identity", cache_control: control }, { type: "text", text: "stable project", cache_control: control }],
messages: [{ role: "user", content: [{ type: "text", text: "first question", cache_control: control }] }] });
function markers(value: unknown): WireObject[] {
  if (Array.isArray(value)) return value.flatMap(markers);
  if (!object(value)) return [];
  return [...(object(value.cache_control) && value.cache_control.type === "ephemeral" ? [value] : []), ...Object.values(value).flatMap(markers)];
}
function shortPayload() {
  const value = payload();
  for (const block of markers(value)) block.cache_control = { type: "ephemeral" };
  return value;
}

test("pins a prior wire prefix across more than 20 new blocks and stays within four markers", () => {
  const original = payload();
  const first = planCache(original, "account", 3_600_000, "conversation", [], 100)!;
  const next = payload();
  next.messages.push({ role: "assistant", content: Array.from({ length: 24 }, (_, index) => ({ type: "text", text: `block ${index}`, cache_control: control })) });
  next.messages.push({ role: "user", content: [{ type: "text", text: "continue", cache_control: control }] });
  const result = planCache(next, "account", 3_600_000, "conversation", first.points, 200)!;
  assert.equal(result.parentHit, true);
  assert.equal(markers(result.payload).length, 4);
  const messages = result.payload.messages as typeof next.messages;
  assert.deepEqual(messages[0].content[0].cache_control, control);
  assert.deepEqual(messages.at(-1)!.content[0].cache_control, control);
  assert.equal(markers(messages[1]).length, 0, "new intermediate blocks are not unnecessary write points");
  assert.deepEqual(original, payload(), "planning must not mutate transcript objects");
  const tools = result.payload.tools as Array<{ input_schema: unknown }>;
  assert.deepEqual(tools[0].input_schema, original.tools[0].input_schema, "schema properties named cache_control are ordinary user data");
});

test("summary pins the parent while keeping one-use instructions outside every message cache point", () => {
  const first = planCache(payload(), "account", 3_600_000, "conversation", [], 100)!;
  const next = payload();
  next.messages.push({ role: "user", content: [{ type: "text", text: "one-use summary instructions", cache_control: control }] });
  const result = planCache(next, "account", 3_600_000, "compaction", first.points, 200)!;
  assert.equal(result.parentHit, true);
  assert.equal(markers((result.payload.messages as unknown[])[0]).length, 1);
  assert.equal(markers((result.payload.messages as unknown[])[1]).length, 0);
  assert.equal(result.points.length, 1);
});

test("deferred placeholders do not steal the stable active-tool breakpoint", () => {
  const input = { ...payload(), tools: [...payload().tools, { name: "placeholder", defer_loading: true }] };
  const result = planCache(input, "account", 300_000, "conversation")!;
  const tools = result.payload.tools as Array<WireObject>;
  assert.ok(tools[0].cache_control);
  assert.equal(tools[1].cache_control, undefined);
});

test("caller mixed TTL, scope and automatic cache controls are preserved byte for byte", () => {
  const mixed = payload();
  mixed.messages[0].content[0].cache_control = { type: "ephemeral" } as typeof control;
  const scoped = payload();
  scoped.system[1].cache_control = { ...control, scope: "global" } as typeof control;
  const automatic = { ...payload(), cache_control: { type: "ephemeral" } };
  for (const input of [mixed, scoped, automatic]) {
    const result = planCache(input, "account", 3_600_000, "conversation")!;
    assert.equal(JSON.stringify(result.payload), JSON.stringify(input), "planning must not alter caller-owned cache pricing or scope");
    assert.equal(result.preservedPolicy, true);
  }
  assert.equal(planCache(mixed, "account", 3_600_000, "conversation")!.ttl, 300_000);
});

test("wire fingerprints detect tool input key reordering instead of calling it the same cached prefix", () => {
  const one = { ...shortPayload(), messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "read", input: { path: "a", limit: 10 } }] }] };
  const first = planCache(one, "account", 300_000, "conversation", [], 100)!;
  const two = { ...one, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "read", input: { limit: 10, path: "a" } }] }] };
  assert.equal(planCache(two, "account", 300_000, "conversation", first.points, 200)!.parentHit, false);
});

test("changed heads, accounts and expired points cannot be pinned; explicit off stays off", () => {
  const first = planCache(shortPayload(), "account", 300_000, "conversation", [], 100)!;
  for (const [input, scope, at] of [
    [{ ...shortPayload(), system: "new system" }, "account", 200],
    [shortPayload(), "another account", 200],
    [shortPayload(), "account", 300_100],
    [{ ...shortPayload(), tools: [] }, "account", 200],
  ] as const) assert.equal(planCache(input, scope, 300_000, "conversation", first.points, at)!.parentHit, false);
  const disabled = planCache(payload(), "account", 0, "conversation", first.points, 200)!;
  assert.equal(markers(disabled.payload).length, 0);
  assert.equal(disabled.points.length, 0);
});

test("only a provider-confirmed response creates reusable points; new tails do not count as misses", () => {
  const ledger = new PromptCacheLedger();
  const first = planCache(payload(), "account", 3_600_000, "conversation", [], 100)!;
  assert.equal(ledger.state.points.length, 0);
  assert.equal(ledger.complete(first, "conversation", { input: 0, cacheRead: 0, cacheWrite: 100_000, cacheWrite1h: 100_000 }, "msg_1", undefined, 100).outcome, "cold");
  const next = payload();
  next.messages.push({ role: "user", content: [{ type: "text", text: "new tail", cache_control: control }] });
  const second = planCache(next, "account", 3_600_000, "conversation", ledger.state.points, 200)!;
  assert.equal(ledger.complete(second, "conversation", { input: 0, cacheRead: 100_000, cacheWrite: 2_000 }, "msg_2", undefined, 200).outcome, "hit");
  assert.equal(ledger.state.misses, 0);
  assert.equal(ledger.state.read, 100_000);
  assert.equal(ledger.state.write, 102_000);
});

test("distinguishes unexpected prefix changes, user tools, compression and TTL expiry", () => {
  const scenario = (expected?: "compaction" | "user_tools_changed", expired = false) => {
    const ledger = new PromptCacheLedger();
    ledger.complete(planCache(shortPayload(), "a", 300_000, "conversation", [], 100)!, "conversation",
      { cacheWrite: 100_000 }, "msg1", undefined, 100);
    if (expected) ledger.expect(expected);
    const next = shortPayload();
    if (expected === "user_tools_changed") next.tools = [];
    else if (!expired) next.messages[0].content[0].text = "changed history";
    return ledger.complete(planCache(next, "a", 300_000, "conversation", ledger.state.points, 200)!, "conversation",
      { cacheWrite: 100_000 }, "msg2", undefined, expired ? 300_200 : 200);
  };
  assert.equal(scenario().reason, "messages_changed");
  assert.equal(scenario().outcome, "miss");
  assert.equal(scenario("user_tools_changed").reason, "user_tools_changed");
  assert.equal(scenario("compaction").outcome, "expected");
  assert.equal(scenario(undefined, true).reason, "ttl_expired");
});

test("resume preserves counters and points; auxiliary requests never replace the conversation baseline", () => {
  const ledger = new PromptCacheLedger();
  const first = planCache(payload(), "a", 3_600_000, "conversation", [], 100)!;
  ledger.complete(first, "conversation", { cacheWrite: 100_000 }, "main", undefined, 100);
  const summary = planCache(payload(), "a", 3_600_000, "compaction", ledger.state.points, 200)!;
  ledger.complete(summary, "compaction", { cacheRead: 100_000, input: 500 }, "summary", undefined, 200);
  const restored = new PromptCacheLedger(JSON.parse(JSON.stringify(ledger.state)));
  assert.equal(restored.state.requests, 2);
  assert.equal(restored.state.baseline?.record.responseId, "main");
  assert.equal(planCache(payload(), "a", 3_600_000, "conversation", restored.state.points, 300)!.parentHit, true);
  assert.doesNotMatch(JSON.stringify(restored.state), /first question|stable project|identity/);
  assert.equal(new PromptCacheLedger({ version: 1, recent: [], points: [], requests: "bad" }).state.requests, 0);
});

test("unrelated old checkpoints are not kept alive by a new branch's response", () => {
  const ledger = new PromptCacheLedger();
  ledger.complete(planCache(shortPayload(), "a", 300_000, "conversation", [], 100)!, "conversation", { cacheWrite: 100_000 }, "old", undefined, 100);
  const changed = shortPayload();
  changed.system[1].text = "other branch";
  ledger.complete(planCache(changed, "a", 300_000, "conversation", [], 200_000)!, "conversation", { cacheWrite: 100_000 }, "new", undefined, 200_000);
  assert.equal(planCache(shortPayload(), "a", 300_000, "conversation", ledger.state.points, 300_200)!.parentHit, false);
});

test("a head-only cache read cannot establish or renew a conversation cache boundary", () => {
  const ledger = new PromptCacheLedger();
  const plan = planCache(shortPayload(), "a", 300_000, "conversation", [], 100)!;
  ledger.complete(plan, "conversation", { input: 100_000, cacheRead: 2_000, cacheWrite: 0 }, "head-only", undefined, 100);
  assert.equal(ledger.state.points.length, 0);
  assert.equal(ledger.state.baseline?.shareable, false);
  ledger.complete(plan, "conversation", { cacheWrite: 100_000 }, "full", undefined, 200);
  const before = ledger.state.points[0].at;
  ledger.complete(plan, "compaction", { input: 100_000, cacheRead: 2_000 }, "head-only-again", undefined, 100_000);
  assert.equal(ledger.state.points[0].at, before);
});

test("compact journal checkpoints keep disk growth bounded and restore recent history and totals", () => {
  const ledger = new PromptCacheLedger();
  const entries: unknown[] = [];
  for (let index = 0; index < 50; index++) {
    const plan = planCache(shortPayload(), "a", 300_000, "conversation", ledger.state.points, 100 + index)!;
    ledger.complete(plan, "conversation", { cacheRead: index ? 100_000 : 0, cacheWrite: index ? 0 : 100_000 }, `msg_${index}`, undefined, 100 + index);
    entries.push({ type: "custom", customType: CACHE_LEDGER_ENTRY, data: cacheLedgerCheckpoint(ledger.state) });
  }
  const restored = restoreCacheLedger(entries)!;
  assert.equal(restored.requests, 50);
  assert.equal(restored.recent.length, 40);
  assert.equal(restored.baseline?.record.responseId, "msg_49");
  assert.ok(JSON.stringify(cacheLedgerCheckpoint(ledger.state)).length < JSON.stringify(ledger.state).length / 3,
    "each saved request must not duplicate the whole rolling history");
});

test("late responses retain the newest cache refresh and conversation baseline", () => {
  const ledger = new PromptCacheLedger();
  const first = planCache(shortPayload(), "a", 300_000, "conversation", [], 100)!;
  ledger.complete(first, "conversation", { cacheWrite: 100_000 }, "first", undefined, 100);
  const pending = planCache(shortPayload(), "a", 300_000, "conversation", ledger.state.points, 200)!;
  const next = shortPayload();
  next.messages.push({ role: "user", content: [{ type: "text", text: "newer request", cache_control: { type: "ephemeral" } as typeof control }] });
  const newer = planCache(next, "a", 300_000, "conversation", ledger.state.points, 100_000)!;
  ledger.complete(newer, "conversation", { cacheRead: 100_000, cacheWrite: 1000 }, "newer", undefined, 100_000);
  ledger.complete(pending, "conversation", { cacheRead: 100_000 }, "late", undefined, 200);
  assert.equal(ledger.state.baseline?.record.responseId, "newer");
  assert.equal(ledger.state.points.find((point) => point.hash === first.boundary?.hash)?.at, 100_000);
  assert.equal(planCache(shortPayload(), "a", 300_000, "conversation", ledger.state.points, 350_000)!.parentHit, true);
  assert.equal(ledger.state.requests, 3, "out-of-order responses still contribute their usage");
});
