import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "@suocode/runtime-protocol";
import {
  parseTerminalNotice,
  terminalNoticeLabel,
  terminalNoticePreview,
} from "../src/renderer/src/features/conversation/terminalNotice.ts";

function notice(text: string, details?: Record<string, unknown>): ChatMessage {
  return {
    id: "m1",
    order: 1,
    role: "system",
    text,
    timestamp: 0,
    custom: { type: "terminal-notification", details },
  };
}

test("a terminal event splits into a headline and its output", () => {
  const parsed = parseTerminalNotice(notice(
    "Terminal term-176：进程已退出（exited）\n#27 23.59 ✓ built in 12.34s\n#36 DONE 2.0s",
    { terminalId: "term-176", mode: "exit", status: "exited" },
  ));
  assert.equal(parsed?.terminalId, "term-176");
  assert.equal(parsed?.reason, "进程已退出（exited）");
  assert.equal(parsed?.mode, "exit");
  assert.equal(parsed?.output, "#27 23.59 ✓ built in 12.34s\n#36 DONE 2.0s");
  assert.equal(terminalNoticeLabel(parsed!), "已退出");
  assert.equal(terminalNoticePreview(parsed!.output), "#36 DONE 2.0s");
});

test("the headline alone still parses, with no details and no output", () => {
  const parsed = parseTerminalNotice(notice("Terminal term-9：匹配到：ready"));
  assert.equal(parsed?.terminalId, "term-9");
  assert.equal(parsed?.reason, "匹配到：ready");
  assert.equal(parsed?.output, "");
  assert.equal(terminalNoticeLabel(parsed!), "终端事件");
});

test("only terminal notifications become cards", () => {
  const other: ChatMessage = { id: "m2", order: 2, role: "system", text: "hello", timestamp: 0 };
  assert.equal(parseTerminalNotice(other), undefined);
});
