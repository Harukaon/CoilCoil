import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fileDiffExtension, { renderFileDiff } from "../extensions/file-diff.ts";

function harness(cwd: string) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  fileDiffExtension({ on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler) } as never);
  const ctx = { cwd };
  return {
    before: (toolName: string, toolCallId: string, input: Record<string, unknown>) =>
      handlers.get("tool_call")!({ type: "tool_call", toolName, toolCallId, input }, ctx),
    after: (toolName: string, toolCallId: string, isError = false, details?: unknown) =>
      handlers.get("tool_result")!({ type: "tool_result", toolName, toolCallId, input: {}, content: [{ type: "text", text: "Successfully wrote" }], isError, details }, ctx) as
        { content: Array<{ text: string }>; details: { fileDiff: Record<string, unknown> } } | undefined,
  };
}

test("修改文件：返回带加减行数的统一 diff", () => {
  const diff = renderFileDiff("src/a.ts", "a\nb\nc\n", "a\nB\nc\nd\n");
  assert.equal(diff?.additions, 2);
  assert.equal(diff?.deletions, 1);
  assert.match(diff!.text, /^已修改 src\/a\.ts（\+2 -1）\n@@ -1,3 \+1,4 @@\n a\n-b\n\+B\n c\n\+d$/);
});

test("新建文件写成「已新建」，内容没变就不给 diff", () => {
  assert.match(renderFileDiff("n.txt", null, "x\ny\n")!.text, /^已新建 n\.txt（2 行）/);
  assert.equal(renderFileDiff("n.txt", "same\n", "same\n"), undefined);
});

test("diff 太长就截断，不把整个大文件塞回给模型", () => {
  const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const diff = renderFileDiff("big.txt", null, big, 50)!;
  assert.match(diff.text, /diff 共 501 行，只显示前 50 行$/);
  assert.equal(diff.text.split("\n").length, 1 + 50 + 1);
});

test("edit 前后对比真实文件，返回换成 diff，details 里保留原来的字段", () => {
  const cwd = mkdtempSync(join(tmpdir(), "coilcoil-file-diff-"));
  try {
    writeFileSync(join(cwd, "a.txt"), "hello\nworld\n");
    const run = harness(cwd);
    run.before("edit", "c1", { path: "a.txt", edits: [] });
    writeFileSync(join(cwd, "a.txt"), "hello\nthere\n");
    const result = run.after("edit", "c1", false, { diff: "pi-diff" });
    assert.match(result!.content[0].text, /^已修改 a\.txt（\+1 -1）[\s\S]*-world\n\+there$/);
    assert.equal((result!.details as Record<string, unknown>).diff, "pi-diff");
    assert.deepEqual(result!.details.fileDiff, { path: "a.txt", additions: 1, deletions: 1, created: false });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("工具失败、二进制文件、别的工具都保留原来的返回", () => {
  const cwd = mkdtempSync(join(tmpdir(), "coilcoil-file-diff-"));
  try {
    const run = harness(cwd);
    run.before("write", "c2", { path: "new.txt", content: "x" });
    writeFileSync(join(cwd, "new.txt"), "x\n");
    assert.equal(run.after("write", "c2", true), undefined, "失败了就不改返回");
    writeFileSync(join(cwd, "bin.dat"), "a\u0000b");
    run.before("write", "c3", { path: "bin.dat", content: "" });
    assert.equal(run.after("write", "c3"), undefined, "二进制不做 diff");
    run.before("bash", "c4", { command: "ls" });
    assert.equal(run.after("bash", "c4"), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
