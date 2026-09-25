import assert from "node:assert/strict";
import test from "node:test";
import { checkpointRewindDescription } from "../src/renderer/src/features/conversation/checkpointRewind.ts";

test("回退说明只报文件数，不列文件名", () => {
  assert.equal(checkpointRewindDescription(120), "这条消息之后 Agent 改动了 120 个文件，回退会把它们恢复到这条消息发出时的样子；其它文件不动。");
});

test("没备份下来的文件单独说一句", () => {
  assert.match(checkpointRewindDescription(2, 1), /另有 1 个文件没有备份/);
});
