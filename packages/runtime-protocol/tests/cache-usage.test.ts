import assert from "node:assert/strict";
import test from "node:test";
import { summarizeCacheUsage } from "../src/index.ts";

test("cache usage keeps Pi's non-overlapping prompt buckets additive", () => {
  assert.deepEqual(summarizeCacheUsage(200, 700, 100), {
    promptTokens: 1_000,
    uncachedTokens: 300,
    cacheReadTokens: 700,
    cacheWriteTokens: 100,
    hitRate: 0.7,
  });
});

test("cache usage clamps malformed provider values and omits an empty rate", () => {
  assert.deepEqual(summarizeCacheUsage(-5, Number.NaN, undefined), {
    promptTokens: 0,
    uncachedTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    hitRate: undefined,
  });
});
