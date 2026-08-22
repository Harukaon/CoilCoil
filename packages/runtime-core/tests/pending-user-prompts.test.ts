import assert from "node:assert/strict";
import test from "node:test";
import { matchPendingUserPrompt } from "../src/message-helpers.js";

test("Pi 回显的用户消息按文本认领对应的 client id", () => {
  const pending = [{ id: "client-1", text: "跑一下测试" }, { id: "client-2", text: "再看看日志" }];
  assert.equal(matchPendingUserPrompt(pending, "再看看日志"), 1);
});

test("goal 轮次自己发的消息不认领任何排队中的 client id", () => {
  // The `/goal` loop sends itself a prompt through sendUserMessage; taking the
  // head here used to hand it the id of the user's own unsent message.
  const pending = [{ id: "client-1", text: "跑一下测试" }];
  assert.equal(matchPendingUserPrompt(pending, "【目标模式 第 3 轮】继续推进：修好构建"), -1);
});

test("没有待确认的消息时不认领", () => {
  assert.equal(matchPendingUserPrompt([], "任何文本"), -1);
});

test("斜杠命令的文本会被 Pi 展开，只有这种情况才认领队首", () => {
  const pending = [{ id: "client-1", text: "/review 这个分支" }];
  assert.equal(matchPendingUserPrompt(pending, "请按以下标准评审当前分支……"), 0);
});

test("队首不是斜杠命令时，展开后的文本不会错认队首", () => {
  const pending = [{ id: "client-1", text: "普通消息" }, { id: "client-2", text: "/review" }];
  assert.equal(matchPendingUserPrompt(pending, "请按以下标准评审当前分支……"), -1);
});

test("重复文本按先进先出认领最早的一条", () => {
  const pending = [{ id: "client-1", text: "继续" }, { id: "client-2", text: "继续" }];
  assert.equal(matchPendingUserPrompt(pending, "继续"), 0);
});

test("带图片提示的消息按拼接后的完整文本匹配", () => {
  const expanded = "看看这张图\n\n[图片 1] screenshot.png";
  const pending = [{ id: "client-1", text: expanded }];
  assert.equal(matchPendingUserPrompt(pending, expanded), 0);
  assert.equal(matchPendingUserPrompt(pending, "看看这张图"), -1);
});
