import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionTitlePrompt,
  claimSessionTitleAttempt,
  sanitizeSessionTitle,
  sessionTitleMarkers,
  SESSION_TITLE_ATTEMPT_ENTRY_TYPE,
  SESSION_TITLE_MANUAL_ENTRY_TYPE,
  SESSION_TITLE_MAX_CHARS,
} from "../src/session-title.js";

test("模型爱加的引号和「标题：」前缀都要剥掉", () => {
  assert.equal(sanitizeSessionTitle('"修复归档卡顿"'), "修复归档卡顿");
  assert.equal(sanitizeSessionTitle("标题：修复归档卡顿"), "修复归档卡顿");
  assert.equal(sanitizeSessionTitle("「修复归档卡顿」"), "修复归档卡顿");
  assert.equal(sanitizeSessionTitle("Title: Fix archive lag"), "Fix archive lag");
  assert.equal(sanitizeSessionTitle("修复归档卡顿。"), "修复归档卡顿");
});

test("推理模型把思考和答案一起吐出来时只取最后一行", () => {
  assert.equal(sanitizeSessionTitle("让我想想这段对话在讲什么\n\n修复归档卡顿"), "修复归档卡顿");
});

test("回了一整段话就当它没回，宁可保留原标题", () => {
  const paragraph = "这段对话主要在讨论归档功能的性能问题。用户反映点击归档之后界面会卡住一会儿。";
  assert.equal(sanitizeSessionTitle(paragraph), undefined);
  assert.equal(sanitizeSessionTitle(""), undefined);
  assert.equal(sanitizeSessionTitle("   \n  "), undefined);
  assert.equal(sanitizeSessionTitle(undefined), undefined);
});

test("没有句号的超长标题截断而不是丢掉", () => {
  const long = "修复".repeat(40);
  const title = sanitizeSessionTitle(long);
  assert.ok(title);
  assert.equal(title.length, SESSION_TITLE_MAX_CHARS);
});

test("命名请求里两段都带上，助手那段为空时只带用户那段", () => {
  const both = buildSessionTitlePrompt("帮我看一下归档为什么卡", "我看了一下，是因为等后端返回");
  assert.match(both, /用户的第一条消息/);
  assert.match(both, /助手的第一条回复/);
  const userOnly = buildSessionTitlePrompt("帮我看一下归档为什么卡", "   ");
  assert.match(userOnly, /用户的第一条消息/);
  assert.doesNotMatch(userOnly, /助手的第一条回复/);
});

test("超长原文会被截断，不会把整段对话塞进命名请求", () => {
  const huge = "a".repeat(10_000);
  const prompt = buildSessionTitlePrompt(huge, huge);
  assert.ok(prompt.length < 6_000, `命名请求不该这么大：${prompt.length}`);
  assert.match(prompt, /已截断/);
});

test("手动标题和自动命名尝试会从会话标记中恢复", () => {
  assert.deepEqual(sessionTitleMarkers([
    { type: "custom", customType: SESSION_TITLE_MANUAL_ENTRY_TYPE },
    { type: "custom", customType: SESSION_TITLE_ATTEMPT_ENTRY_TYPE },
    { type: "custom", customType: "other" },
  ]), { titleAttempted: true, titleManuallySet: true });
});

test("自动命名只能被同一个会话抢占一次，手动标题直接拒绝", () => {
  const state = { titlePending: true };
  assert.equal(claimSessionTitleAttempt(state), true);
  assert.equal(claimSessionTitleAttempt(state), false);
  assert.deepEqual(state, { titlePending: false, titleAttempted: true });
  assert.equal(claimSessionTitleAttempt({ titlePending: true, titleManuallySet: true }), false);
});
