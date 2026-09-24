import assert from "node:assert/strict";
import test from "node:test";
import { checkpointRewindDescription } from "../src/renderer/src/features/conversation/checkpointRewind.ts";

test("回退说明：列前三个文件，其余用数量带过；有新建的才提会删除", () => {
  const text = checkpointRewindDescription([
    { path: "a.txt", state: "modified" },
    { path: "b.txt", state: "added" },
    { path: "c.txt", state: "deleted" },
    { path: "d.txt", state: "modified" },
  ]);
  assert.match(text, /a\.txt、b\.txt、c\.txt 等 4 个文件 被改过/);
  assert.doesNotMatch(text, /d\.txt/);
  assert.match(text, /新建的文件会被删除/);
  assert.doesNotMatch(checkpointRewindDescription([{ path: "a.txt", state: "modified" }]), /新建的文件会被删除|等/);
});
