import assert from "node:assert/strict";
import test from "node:test";
import { diffStats, parseUnifiedDiff, splitRows } from "../src/renderer/src/features/git/gitDiff.ts";

const PATCH = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,4 +1,5 @@ function top()",
  " one",
  "-two",
  "-three",
  "+TWO",
  " four",
  "+five",
  "+six",
  "\\ No newline at end of file",
  "@@ -10,2 +11,1 @@",
  " ten",
  "-eleven",
  "",
].join("\n");

test("git diff：跳过文件头，行号从 hunk 头算，「No newline」不算一行", () => {
  const hunks = parseUnifiedDiff(PATCH);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0]!.header, "@@ -1,4 +1,5 @@ function top()");
  assert.deepEqual(hunks[0]!.lines, [
    { kind: "context", text: "one", oldNumber: 1, newNumber: 1 },
    { kind: "del", text: "two", oldNumber: 2 },
    { kind: "del", text: "three", oldNumber: 3 },
    { kind: "add", text: "TWO", newNumber: 2 },
    { kind: "context", text: "four", oldNumber: 4, newNumber: 3 },
    { kind: "add", text: "five", newNumber: 4 },
    { kind: "add", text: "six", newNumber: 5 },
  ]);
  assert.deepEqual(hunks[1]!.lines.map((line) => [line.kind, line.oldNumber, line.newNumber]), [
    ["context", 10, 11],
    ["del", 11, undefined],
  ]);
  assert.deepEqual(diffStats(hunks), { additions: 3, deletions: 3 });
});

test("左右对照：删除和紧跟的新增按顺序配对，多出来的一边留空", () => {
  const rows = splitRows(parseUnifiedDiff(PATCH)[0]!);
  assert.deepEqual(rows.map((row) => [row.left?.text, row.right?.text]), [
    ["one", "one"],
    ["two", "TWO"],
    ["three", undefined],
    ["four", "four"],
    [undefined, "five"],
    [undefined, "six"],
  ]);
});

test("空 diff 和只有文件头的 diff 都没有 hunk", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
  assert.deepEqual(parseUnifiedDiff("diff --git a/x b/x\nBinary files a/x and b/x differ\n"), []);
});
