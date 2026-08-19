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

test("a persisted custom_message entry still maps to its card", () => {
  // Pi stores these under their own entry type, with the payload on the entry
  // rather than under `message`. Reconstruction has to rebuild the message
  // around it, or the card shows while the turn runs and disappears when the
  // turn's end replaces the transcript with a fresh snapshot.
  const entry = {
    type: "custom_message",
    id: "entry-9",
    customType: "terminal-notification",
    content: "Terminal term-176：进程已退出（exited）\nbuilt in 12.34s",
    display: true,
    details: { terminalId: "term-176", mode: "exit", status: "exited" },
    timestamp: 1_700_000_000_000,
  };
  const mapped = mapMessage({
    role: "custom",
    customType: entry.customType,
    content: entry.content,
    display: entry.display,
    details: entry.details,
    timestamp: entry.timestamp,
  }, `history-${entry.id}`, 3);

  assert.equal(mapped?.role, "system");
  assert.equal(mapped?.custom?.type, "terminal-notification");
  assert.equal(mapped?.custom?.details?.terminalId, "term-176");
  assert.match(mapped?.text ?? "", /进程已退出/);
});
