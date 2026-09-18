import type { MacPermissionId } from "../../../../shared/desktop-api";

/**
 * 首次启动的引导：有哪几步、哪一步能跳、哪一步必须先做个决定。
 *
 * 这里只有规则，没有界面。规则单独放一份是因为「权限那一步不能跳过」是这套流程
 * 唯一的硬约束，它值得被测到——界面改版不该把它一起改没了。
 */

export type OnboardingStepId = "intro" | "model" | "permissions" | "workspace";

/** 对单项权限的处置。没有「不表态」这一档。 */
export type PermissionDecision = "grant" | "skip";

export const ONBOARDING_STEPS: readonly OnboardingStepId[] = ["intro", "model", "permissions", "workspace"];

/**
 * 引导里会问到的权限，按「Agent 可能拿它干什么」排。
 *
 * 这里**不做推荐**：给多给少是用户自己的判断，我们只负责把用途说清楚。四项在
 * macOS 里是彼此独立的开关——「完全磁盘访问权限」既不包含「App 管理」也不包含
 * 「屏幕录制」，所以一项一项地问。
 */
export interface PermissionTopic {
  id: MacPermissionId;
  name: string;
  /** Agent 可能拿它来做什么。一句话，说事实，不劝。 */
  purpose: string;
}

export const PERMISSION_TOPICS: readonly PermissionTopic[] = [
  { id: "full-disk", name: "完全磁盘访问权限", purpose: "读系统保护起来的目录，以及把你已有浏览器的登录状态导进内置浏览器。" },
  { id: "screen-recording", name: "屏幕录制与截屏", purpose: "Agent 想看一眼页面真正渲染成什么样，或者录一段复现步骤。macOS 把截屏和录屏放在同一个开关里。" },
  { id: "app-management", name: "App 管理", purpose: "让 Agent 改动或更新「应用程序」里的 App。这一项不包含在完全磁盘访问权限里。" },
  { id: "accessibility", name: "辅助功能", purpose: "让 Agent 代你点按、输入，去操作别的 App。" },
];

export type PermissionDecisions = Partial<Record<MacPermissionId, PermissionDecision>>;

export interface OnboardingProgress {
  step: OnboardingStepId;
  /** 每一项权限给还是不给。逐项都有了才算表过态。 */
  permissions: PermissionDecisions;
}

export const INITIAL_ONBOARDING: OnboardingProgress = { step: "intro", permissions: {} };

export function stepIndex(step: OnboardingStepId): number {
  return ONBOARDING_STEPS.indexOf(step);
}

export function isLastStep(step: OnboardingStepId): boolean {
  return stepIndex(step) === ONBOARDING_STEPS.length - 1;
}

/**
 * 这一步能不能跳过。
 *
 * 模型和工作区都能：没配模型也能先进来看看，没挂目录也能先开着。权限不能——每一项
 * 都要用户自己说给还是不给。这是个写代码的工具，Agent 要读项目目录、要截屏看页面、
 * 要把别的浏览器的登录状态导进来，而 macOS 默认全是拒绝的，**被拒绝时很多系统接口
 * 长得和「东西不在」一模一样**，功能会静悄悄地消失而不是报错（见
 * main/browser-import/browser-catalog.ts 那一次）。第一页只是介绍，没有跳过的意义。
 */
export function canSkip(step: OnboardingStepId): boolean {
  return step === "model" || step === "workspace";
}

/** 每一项权限都表过态了没有。 */
export function allPermissionsDecided(
  decisions: PermissionDecisions,
  topics: readonly PermissionTopic[] = PERMISSION_TOPICS,
): boolean {
  return topics.every((topic) => decisions[topic.id] !== undefined);
}

export function canAdvance(progress: OnboardingProgress): boolean {
  if (progress.step !== "permissions") return true;
  return allPermissionsDecided(progress.permissions);
}

export function advance(progress: OnboardingProgress): OnboardingProgress {
  if (!canAdvance(progress)) return progress;
  const next = ONBOARDING_STEPS[stepIndex(progress.step) + 1];
  return next ? { ...progress, step: next } : progress;
}

export function goBack(progress: OnboardingProgress): OnboardingProgress {
  const previous = ONBOARDING_STEPS[stepIndex(progress.step) - 1];
  return previous ? { ...progress, step: previous } : progress;
}

export const ONBOARDING_STEP_LABELS: Record<OnboardingStepId, string> = {
  intro: "认识",
  model: "模型",
  permissions: "权限",
  workspace: "工作区",
};
