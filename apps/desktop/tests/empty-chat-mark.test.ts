import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const rendererRoot = resolve(import.meta.dirname, "../src/renderer/src");
const pane = readFileSync(resolve(rendererRoot, "features/conversation/ConversationPane.tsx"), "utf8");

test("Home 空态顶上放的是标志，不是加载动画", () => {
  // 空态什么都没在加载，摆一个转圈的图标会让人以为卡住了。
  // 而且这里和左下角必须是同一枚标志——用户要求的，所以两处都挂 .brand-icon。
  const mark = /<div className="empty-chat-mark">([\s\S]*?)<\/div>/.exec(pane);
  assert.ok(mark, "找不到 .empty-chat-mark 这一块");
  assert.match(mark[1], /className="brand-icon"/);
  assert.doesNotMatch(mark[1], /CoilLogo/, "空态又被换回墨团标志了，和左下角对不上");
  assert.doesNotMatch(mark[1], /Loader\b/, "空态又被换回加载动画了");
});
