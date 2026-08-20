import assert from "node:assert/strict";
import test from "node:test";
import { endedGoalPayload, goalState } from "../src/runtime-state.js";

const running = { status: "running", goal: "把发布流程跑通", iteration: 4, startedAt: 1, updatedAt: 2 };

test("a live loop is read as the session's goal", () => {
  const parsed = goalState(running);
  assert.equal(parsed?.status, "running");
  assert.equal(parsed?.iteration, 4);
  assert.equal(goalState({ ...running, status: "paused" })?.status, "paused");
});

test("a loop that ended is not a goal the session has", () => {
  assert.equal(goalState({ ...running, status: "completed", summary: "做完了" }), undefined);
  assert.equal(goalState({ ...running, status: "stopped" }), undefined);
  // The session drops the goal on these rather than ignoring them, which is the
  // difference between a finished loop and a payload we simply cannot read.
  assert.equal(endedGoalPayload({ ...running, status: "completed" }), true);
  assert.equal(endedGoalPayload({ ...running, status: "stopped" }), true);
});

test("an unreadable payload is neither a goal nor the end of one", () => {
  assert.equal(goalState({ status: "running" }), undefined, "a goal needs its text");
  assert.equal(goalState({ status: "什么", goal: "x" }), undefined);
  assert.equal(goalState(null), undefined);
  assert.equal(endedGoalPayload({ status: "running", goal: "x" }), false);
  assert.equal(endedGoalPayload("stopped"), false);
  assert.equal(endedGoalPayload(null), false);
});
