import assert from "node:assert/strict";
import test from "node:test";
import { parseFileDiffOutput } from "../src/renderer/src/features/conversation/fileDiffOutput.ts";

test("edit 的 diff 返回：读出路径、加减行数，每行按类型分好", () => {
  const diff = parseFileDiffOutput("edit", "已修改 src/a.ts（+2 -1）\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d");
  assert.equal(diff?.path, "src/a.ts");
  assert.equal(diff?.additions, 2);
  assert.equal(diff?.deletions, 1);
  assert.deepEqual(diff?.lines.map((line) => line.kind), ["hunk", "context", "del", "add", "context", "add"]);
});

test("write 新建文件：只有新增", () => {
  const diff = parseFileDiffOutput("write", "已新建 notes.txt（2 行）\n@@ -0,0 +1,2 @@\n+x\n+y\n……diff 共 900 行，只显示前 200 行");
  assert.deepEqual([diff?.path, diff?.additions, diff?.deletions], ["notes.txt", 2, 0]);
  assert.equal(diff?.lines.at(-1)?.kind, "note");
});

test("不是 diff 格式、或者不是 edit/write，就不当 diff 渲染", () => {
  assert.equal(parseFileDiffOutput("edit", "Successfully replaced 1 block(s) in a.ts."), undefined);
  assert.equal(parseFileDiffOutput("bash", "已修改 a（+1 -0）"), undefined);
});
