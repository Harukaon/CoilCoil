import assert from "node:assert/strict";
import test from "node:test";
import { formatTurnDuration } from "../extensions/response-metrics.ts";

test("conversation duration stays compact across seconds, minutes, and hours", () => {
  assert.equal(formatTurnDuration(8_680), "8.68s");
  assert.equal(formatTurnDuration(64_400), "1m4s");
  assert.equal(formatTurnDuration(3_754_000), "1h3m");
});
