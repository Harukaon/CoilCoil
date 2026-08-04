import assert from "node:assert/strict";
import test from "node:test";
import { buildCompactToolLines } from "../extensions/compact-tool-render.ts";

const plainTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

test("completed tools collapse to one purpose-bound line", () => {
  const lines = buildCompactToolLines(
    {
      toolName: "bash",
      toolCallId: "call-1",
      args: {
        command: "a very long command that should not be rendered",
        purpose: "提取费率倍率",
      },
      executionStarted: true,
      isPartial: false,
      result: {
        content: [{ type: "text", text: "large output that is hidden" }],
        isError: false,
      },
      startedAt: 100,
      completedAt: 1_250,
    },
    100,
    plainTheme,
  );

  assert.deepEqual(lines, ["✓ bash · 提取费率倍率 · 1.1s"]);
});

test("running tools show only the last three output lines", () => {
  const lines = buildCompactToolLines(
    {
      toolName: "terminal",
      toolCallId: "call-2",
      args: { purpose: "读取服务日志" },
      executionStarted: true,
      isPartial: true,
      result: {
        content: [{ type: "text", text: "one\ntwo\nthree\nfour" }],
        isError: false,
      },
    },
    100,
    plainTheme,
  );

  assert.deepEqual(lines, [
    "● terminal · 读取服务日志",
    "│ two",
    "│ three",
    "│ four",
  ]);
});

test("failed tools remain one line with a compact error summary", () => {
  const lines = buildCompactToolLines(
    {
      toolName: "grep",
      toolCallId: "call-3",
      args: { purpose: "查找计费逻辑" },
      executionStarted: true,
      isPartial: false,
      result: {
        content: [{ type: "text", text: "context\nPath not found" }],
        isError: true,
      },
    },
    100,
    plainTheme,
  );

  assert.deepEqual(lines, ["✗ grep · 查找计费逻辑 · Path not found"]);
});
