import assert from "node:assert/strict";
import { test } from "node:test";
import { PageCursors } from "../src/main/browser-page-cursor";

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

test("Agent 在链接上移动虚拟鼠标不把用户的箭头变成小手", async () => {
  const sent: string[] = [];
  const cursors = new PageCursors((_id, cursor) => sent.push(cursor), 5);
  cursors.userMoved("tab");
  cursors.pageChanged("tab", "default");
  cursors.agentMoved("tab");
  cursors.pageChanged("tab", "pointer");
  await settle();
  assert.deepEqual(sent, ["default"]);
  cursors.forget("tab");
});

test("Agent 的光标与用户新位置同种时，用户移动后仍能恢复正确光标", async () => {
  const sent: string[] = [];
  const cursors = new PageCursors((_id, cursor) => sent.push(cursor), 5);
  cursors.userMoved("tab");
  cursors.pageChanged("tab", "default");
  cursors.agentMoved("tab");
  cursors.pageChanged("tab", "pointer");
  cursors.userMoved("tab");
  // 页面已经认为光标是手型，不再发 cursor-changed；等待输入那一帧处理完补上。
  await settle();
  assert.deepEqual(sent, ["default", "pointer"]);
  cursors.forget("tab");
});

test("用户移动时的新反馈优先，切页/关页不会留下迟到的光标", async () => {
  const sent: string[] = [];
  const cursors = new PageCursors((tab, cursor) => sent.push(`${tab}:${cursor}`), 5);
  cursors.pageChanged("tab", "pointer");
  cursors.userMoved("tab");
  cursors.pageChanged("tab", "default");
  await settle();
  assert.deepEqual(sent, ["tab:default"]);
  cursors.switched("tab");
  cursors.userMoved("tab");
  cursors.forget("tab");
  await settle();
  assert.deepEqual(sent, ["tab:default"]);
});
