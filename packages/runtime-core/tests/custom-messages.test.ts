import assert from "node:assert/strict";
import test from "node:test";
import { mapMessage } from "../src/message-helpers.js";

test("a displayed custom message keeps the type and details the UI renders from", () => {
  const mapped = mapMessage({
    role: "custom",
    customType: "terminal-notification",
    content: "Terminal term-176：进程已退出（exited）\nbuilt in 12.34s",
    display: true,
    details: { terminalId: "term-176", mode: "exit", status: "exited" },
    timestamp: 1_700_000_000_000,
  }, "message-1", 7);

  assert.equal(mapped?.role, "system");
  assert.equal(mapped?.custom?.type, "terminal-notification");
  assert.deepEqual(mapped?.custom?.details, { terminalId: "term-176", mode: "exit", status: "exited" });
  assert.match(mapped?.text ?? "", /进程已退出/);
});

test("a hidden custom message stays out of the transcript", () => {
  assert.equal(mapMessage({ role: "custom", customType: "internal", content: "x", display: false }, "id", 1), undefined);
});
