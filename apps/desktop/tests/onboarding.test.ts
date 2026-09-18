import assert from "node:assert/strict";
import test from "node:test";
import {
  advance,
  allPermissionsDecided,
  canAdvance,
  canSkip,
  goBack,
  INITIAL_ONBOARDING,
  isLastStep,
  ONBOARDING_STEPS,
  PERMISSION_TOPICS,
  type OnboardingProgress,
  type PermissionDecisions,
  stepIndex,
} from "../src/renderer/src/features/onboarding/onboardingSteps.ts";

function decideAll(decision: "grant" | "skip"): PermissionDecisions {
  return Object.fromEntries(PERMISSION_TOPICS.map((topic) => [topic.id, decision]));
}

test("四步的顺序是固定的，第一步是介绍，最后一步是挂工作区", () => {
  assert.deepEqual([...ONBOARDING_STEPS], ["intro", "model", "permissions", "workspace"]);
  assert.equal(INITIAL_ONBOARDING.step, "intro");
  assert.equal(isLastStep("workspace"), true);
  assert.equal(isLastStep("permissions"), false);
});

test("权限那一步不能跳过，模型和工作区可以", () => {
  assert.equal(canSkip("permissions"), false);
  assert.equal(canSkip("intro"), false, "第一页只是介绍，没有跳过的意义");
  assert.equal(canSkip("model"), true);
  assert.equal(canSkip("workspace"), true);
});

test("问到的权限都是彼此独立的那几项，而且都带用途说明", () => {
  // 「完全磁盘访问权限」不包含「App 管理」，也不包含「屏幕录制」——在 macOS 里是三个
  // 各自独立的开关，所以要一项一项地问。
  assert.deepEqual(PERMISSION_TOPICS.map((topic) => topic.id), ["full-disk", "screen-recording", "app-management", "accessibility"]);
  for (const topic of PERMISSION_TOPICS) {
    assert.ok(topic.name.length > 0, `${topic.id} 没有名字`);
    assert.ok(topic.purpose.length > 10, `${topic.id} 没把用途说清楚`);
  }
});

test("每一项权限都表过态，这一步才走得下去", () => {
  const untouched: OnboardingProgress = { step: "permissions", permissions: {} };
  assert.equal(canAdvance(untouched), false);
  assert.deepEqual(advance(untouched), untouched, "拦住的时候必须原地不动");

  // 少一项都不行。
  const partial: OnboardingProgress = { step: "permissions", permissions: { "full-disk": "grant" } };
  assert.equal(canAdvance(partial), false);

  for (const decision of ["grant", "skip"] as const) {
    const done: OnboardingProgress = { step: "permissions", permissions: decideAll(decision) };
    assert.equal(canAdvance(done), true);
    assert.equal(advance(done).step, "workspace");
    assert.deepEqual(advance(done).permissions, decideAll(decision), "处置要跟着走，最后要存下来");
  }
});

test("给和不给混着选，也算表过态", () => {
  const mixed: PermissionDecisions = { "full-disk": "grant", "screen-recording": "grant", "app-management": "skip", accessibility: "skip" };
  assert.equal(allPermissionsDecided(mixed), true);
  assert.equal(canAdvance({ step: "permissions", permissions: mixed }), true);
});

test("别的步骤随时能往下走", () => {
  for (const step of ["intro", "model", "workspace"] as const) {
    assert.equal(canAdvance({ step, permissions: {} }), true);
  }
});

test("一路走到底，再往前就停住", () => {
  let progress: OnboardingProgress = INITIAL_ONBOARDING;
  progress = advance(progress);
  assert.equal(progress.step, "model");
  progress = advance(progress);
  assert.equal(progress.step, "permissions");
  progress = advance({ ...progress, permissions: decideAll("skip") });
  assert.equal(progress.step, "workspace");
  // 最后一步之后没有下一步：真正的「完成」由界面调 onDone，不是再 advance 一次。
  assert.deepEqual(advance(progress), progress);
});

test("往回走，走到第一步就停住", () => {
  assert.equal(goBack({ step: "workspace", permissions: {} }).step, "permissions");
  assert.equal(goBack({ step: "intro", permissions: {} }).step, "intro");
  assert.equal(stepIndex("intro"), 0);
});
