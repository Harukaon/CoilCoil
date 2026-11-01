import assert from "node:assert/strict";
import test from "node:test";
import { planCache, type WireObject, object } from "../extensions/cache/wire.ts";
import { PromptCacheLedger } from "../extensions/cache/ledger.ts";

/** Independent API-contract fixture: exact wire strings, 20-position lookback,
 * writes only at marked boundaries, and mixed-TTL A/B/C billing. Each text
 * character is one synthetic input unit; this is not a tokenizer or a live API.
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 */
class PrefixServer {
  private entries = new Map<string, { at: number; ttl: number }>();

  send(payload: WireObject, now: number) {
    const positions: Array<{ key: string; tokens: number; ttl?: number }> = [];
    let key = String(payload.model), total = 0;
    const append = (raw: unknown, envelope = "") => {
      assert.ok(object(raw));
      const { cache_control, ...content } = raw;
      key += envelope + JSON.stringify(content);
      total += typeof content.text === "string" ? content.text.length : JSON.stringify(content).length;
      positions.push({ key, tokens: total, ttl: object(cache_control) ? cache_control.ttl === "1h" ? 3_600_000 : 300_000 : undefined });
    };
    for (const tool of payload.tools as unknown[] ?? []) append(tool, "tools");
    for (const block of payload.system as unknown[] ?? []) append(block, "system");
    for (const raw of payload.messages as unknown[]) {
      assert.ok(object(raw) && Array.isArray(raw.content));
      raw.content.forEach((block, index) => append(block, index === 0 ? `message:${raw.role}` : ""));
    }
    if (object(payload.cache_control) && positions.length) positions.at(-1)!.ttl = payload.cache_control.ttl === "1h" ? 3_600_000 : 300_000;
    let read = 0, last = 0, long = 0;
    const found = new Set<string>();
    for (let index = 0; index < positions.length; index++) {
      const point = positions[index];
      if (!point.ttl) continue;
      last = point.tokens;
      for (let check = index; check >= Math.max(0, index - 19); check--) {
        const cached = this.entries.get(positions[check].key);
        if (cached && now - cached.at < cached.ttl) {
          read = Math.max(read, positions[check].tokens);
          found.add(positions[check].key);
          break;
        }
      }
    }
    for (const point of positions) if (point.ttl === 3_600_000 && point.tokens > read) long = Math.max(long, point.tokens - read);
    for (const cached of found) this.entries.get(cached)!.at = now;
    for (const point of positions) if (point.ttl) this.entries.set(point.key, { at: now, ttl: point.ttl });
    const usage = { input: total - last, cacheRead: read, cacheWrite: last - read, cacheWrite1h: long, output: 0 };
    const cost = usage.input + read * 0.05 + long * 2 + (usage.cacheWrite - long) * 1.25;
    return { usage, cost };
  }
}

type Message = { role: string; content: Array<{ type: string; text: string; cache_control?: WireObject }> };
function request(messages: Message[], mixed = false): WireObject {
  const body = { model: "claude-sonnet-5-5", system: [{ type: "text", text: "s".repeat(1000), cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: structuredClone(messages) };
  body.messages.at(-1)!.content.at(-1)!.cache_control = mixed ? { type: "ephemeral" } : { type: "ephemeral", ttl: "1h" };
  return body;
}
const message = (role: string, size: number): Message => ({ role, content: [{ type: "text", text: role[0].repeat(size) }] });

test("ordinary append-only turns cost the same as the SDK's tail breakpoint", () => {
  const original = new PrefixServer(), planned = new PrefixServer(), ledger = new PromptCacheLedger();
  const history: Message[] = [message("user", 10_000)];
  let originalCost = 0, plannedCost = 0;
  for (let turn = 0; turn < 5; turn++) {
    const body = request(history);
    const plan = planCache(body, "account", 3_600_000, "conversation", ledger.state.points, turn * 1000)!;
    const actual = planned.send(plan.payload, turn * 1000);
    originalCost += original.send(body, turn * 1000).cost;
    plannedCost += actual.cost;
    ledger.complete(plan, "conversation", actual.usage, `msg_${turn}`, undefined, turn * 1000);
    history.push(message("assistant", 500), message("user", 100));
  }
  assert.equal(plannedCost, originalCost);
});

test("pinning the parent prevents a full history rewrite when growth exceeds the lookback window", () => {
  const original = new PrefixServer(), planned = new PrefixServer(), ledger = new PromptCacheLedger();
  const history: Message[] = [message("user", 10_000)];
  const first = request(history);
  original.send(first, 0);
  const plan = planCache(first, "account", 3_600_000, "conversation", [], 0)!;
  const written = planned.send(plan.payload, 0);
  ledger.complete(plan, "conversation", written.usage, "first", undefined, 0);
  history.push({ role: "assistant", content: Array.from({ length: 24 }, (_, index) => ({ type: "text", text: `${index}:` + "a".repeat(100) })) }, message("user", 100));
  const next = request(history);
  const safe = planCache(next, "account", 3_600_000, "conversation", ledger.state.points, 1000)!;
  const before = original.send(next, 1000), after = planned.send(safe.payload, 1000);
  assert.ok(after.usage.cacheRead > before.usage.cacheRead);
  assert.ok(after.cost < before.cost);
});

test("a one-use summary instruction stays ordinary input instead of becoming an expensive write", () => {
  const original = new PrefixServer(), planned = new PrefixServer(), ledger = new PromptCacheLedger();
  const history: Message[] = [message("user", 10_000)];
  const first = request(history);
  original.send(first, 0);
  const plan = planCache(first, "account", 3_600_000, "conversation", [], 0)!;
  ledger.complete(plan, "conversation", planned.send(plan.payload, 0).usage, "first", undefined, 0);
  history.push(message("user", 2000));
  const next = request(history);
  const summary = planCache(next, "account", 3_600_000, "compaction", ledger.state.points, 1000)!;
  const before = original.send(next, 1000), after = planned.send(summary.payload, 1000);
  assert.equal(after.usage.cacheRead, before.usage.cacheRead);
  assert.equal(after.usage.cacheWrite, 0);
  assert.equal(after.usage.input, 2000);
  assert.ok(after.cost < before.cost);
});

test("mixed TTL tails never get silently promoted to 1h, including after their 5m cache expires", () => {
  const original = new PrefixServer(), planned = new PrefixServer();
  const history: Message[] = [message("user", 10_000)];
  for (const now of [0, 360_000]) {
    const body = request(history, true);
    const safe = planCache(body, "account", 3_600_000, "conversation", [], now)!;
    const before = original.send(body, now), after = planned.send(safe.payload, now);
    assert.deepEqual(after, before);
    assert.equal(after.usage.cacheWrite1h, now === 0 ? 1000 : 0);
    history.push(message("assistant", 1000), message("user", 100));
  }
});
