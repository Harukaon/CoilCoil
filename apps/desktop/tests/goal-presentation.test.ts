import assert from "node:assert/strict";
import test from "node:test";
import type { GoalState } from "@coilcoil/runtime-protocol";
import { goalStatusLine, goalToggleLabel } from "../src/renderer/src/features/activity/goalPresentation.ts";

function goal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    status: "running",
    goal: "把发布流程跑通",
    iteration: 3,
    startedAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

test("the status line says why the loop is not advancing", () => {
  assert.equal(goalStatusLine(goal()), "进行中 · 第 3 轮");
  assert.equal(goalStatusLine(goal({ lastError: "500" })), "进行中 · 第 3 轮 · 上一轮出错，正在重试");
  assert.equal(goalStatusLine(goal({ status: "paused" })), "已暂停 · 第 3 轮 · 发送 /goal 继续");
  // A paused loop is not retrying anything, so the error from its last round is
  // not the reason it is standing still.
  assert.equal(goalStatusLine(goal({ status: "paused", lastError: "500" })), "已暂停 · 第 3 轮 · 发送 /goal 继续");
});

test("the collapsed header tracks the round", () => {
  assert.equal(goalToggleLabel(goal()), "第 3 轮");
  assert.equal(goalToggleLabel(goal({ status: "paused" })), "已暂停");
});
