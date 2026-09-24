import assert from "node:assert/strict";
import test from "node:test";
import { checkpointRewindDescription } from "../src/renderer/src/features/conversation/checkpointRewind.ts";

test("回退说明只报文件数，不列文件名", () => {
  assert.equal(checkpointRewindDescription(120), "这条消息之后改动了 120 个文件，回退会把它们恢复到这条消息发出时的样子。");
});
