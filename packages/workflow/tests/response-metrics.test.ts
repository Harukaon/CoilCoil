import assert from "node:assert/strict";
import test from "node:test";
import responseMetricsExtension, { formatTurnDuration } from "../extensions/response-metrics.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("conversation duration stays compact across seconds, minutes, and hours", () => {
  assert.equal(formatTurnDuration(8_680), "8.68s");
  assert.equal(formatTurnDuration(64_400), "1m4s");
  assert.equal(formatTurnDuration(3_754_000), "1h3m");
});

test("each provider response is published before the complete agent run settles", () => {
  const handlers = new Map<string, Array<(event?: any, context?: any) => void>>();
  const entries: unknown[] = [];
  const pi = {
    on(name: string, handler: (event?: any, context?: any) => void) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
  } as unknown as ExtensionAPI;
  responseMetricsExtension(pi);
  const emit = (name: string, event?: unknown): void => {
    for (const handler of handlers.get(name) ?? []) handler(event, { hasUI: false });
  };
  const assistant = { message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 0 } } };

  emit("before_agent_start");
  emit("before_provider_request");
  emit("message_end", assistant);
  assert.equal(entries.length, 1);
  emit("before_provider_request");
  emit("message_end", assistant);
  assert.equal(entries.length, 2);
  emit("agent_settled");
  assert.equal(entries.length, 2);
});
