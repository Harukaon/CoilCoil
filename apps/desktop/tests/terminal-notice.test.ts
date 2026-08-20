import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "@suocode/runtime-protocol";
import {
  parseTerminalNotice,
  parseTerminalNotices,
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

test("a batched event becomes one card per terminal", () => {
  const parsed = parseTerminalNotices(notice(
    "3 个终端有新的事件：\n\nTerminal term-1：进程已退出（exited）\nbuilt in 1.2s"
    + "\n\nTerminal term-2：输出匹配正则：Listening on \\d+\nListening on 4321"
    + "\n\nTerminal term-3：进程已退出（failed）",
    {
      count: 3,
      omitted: 0,
      notices: [
        { terminalId: "term-1", mode: "exit", status: "exited", reason: "进程已退出（exited）", output: "built in 1.2s" },
        { terminalId: "term-2", mode: "regex", status: "running", reason: "输出匹配正则：Listening on \\d+", output: "Listening on 4321" },
        { terminalId: "term-3", mode: "exit", status: "failed", reason: "进程已退出（failed）", output: "" },
      ],
    },
  ));

  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map((item) => item.terminalId), ["term-1", "term-2", "term-3"]);
  assert.equal(parsed[1]?.output, "Listening on 4321");
  assert.equal(terminalNoticeLabel(parsed[1]!), "运行中");
  assert.equal(terminalNoticeLabel(parsed[2]!), "失败");
  assert.equal(parsed[2]?.output, "");
});

test("a message from before batching still parses from its headline", () => {
  const parsed = parseTerminalNotices(notice("Terminal term-4：进程已退出（exited）\ndone", { terminalId: "term-4" }));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.terminalId, "term-4");
  assert.equal(parsed[0]?.output, "done");
});

test("a malformed notices array falls back to the message text", () => {
  const parsed = parseTerminalNotices(notice("Terminal term-5：进程已退出（exited）", { notices: [42, null] }));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.terminalId, "term-5");
});
