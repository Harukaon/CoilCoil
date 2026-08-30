import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { conversationStatusKind, unreadConversationCount } from "../src/renderer/src/features/workspaces/sessionList";

/*
 * 「跑完了没看」这件事有三个出口：侧栏对话行的点、工作区文件夹行的点、Dock 角标。
 * 三个必须说同一件事。界面里的两个点是绿的：用户说红色「有点突兀，感觉像错误一样」，
 * 而「跑完了等你看」不是出错。Dock 角标不在这里管，那是系统画的红底白字，保持不变。
 */

const styles = readFileSync(resolve(import.meta.dirname, "../src/renderer/src/styles.css"), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(styles);
  assert.ok(match, `styles.css 里找不到 ${selector}`);
  return match[1];
}

test("角标只数未读，不数还在跑的", () => {
  const activity = {
    "/a": { running: false, unread: true },
    "/b": { running: true, unread: true },   // 还在跑，不需要你做任何事
    "/c": { running: false, unread: false },
    "/d": { running: false, unread: true },
  };
  assert.equal(unreadConversationCount(activity), 2);
  // 全部读完要归零，否则上一次的数字会一直挂在 Dock 图标上。
  assert.equal(unreadConversationCount({ "/a": { running: false, unread: false } }), 0);
  assert.equal(unreadConversationCount({}), 0);
});

test("对话行：运行中显示转圈，跑完没看才是那个点", () => {
  assert.equal(conversationStatusKind({ running: true, unread: true }, false), "running");
  assert.equal(conversationStatusKind({ running: false, unread: true }, true), "unread");
  assert.equal(conversationStatusKind({ running: false, unread: false }, true), "pinned");
  assert.equal(conversationStatusKind(undefined, false), "none");
});

test("两处未读点都是绿的，而且是静止的", () => {
  for (const selector of [".conversation-unread", ".project-activity"]) {
    assert.match(rule(selector), /background: var\(--c-green-solid\)/, `${selector} 的未读点不是绿的`);
  }
  // 呼吸动画整个去掉了：运行中改成转圈，未读是静止的一个点，没有第三种状态需要它。
  assert.doesNotMatch(styles, /project-activity-pulse/, "绿点扩散动画应该已经删掉");
});
