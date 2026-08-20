import type { GoalState } from "@coilcoil/runtime-protocol";

/** Collapsed-header summary: what the loop is doing right now. */
export function goalToggleLabel(goal: GoalState): string {
  return goal.status === "paused" ? "已暂停" : `第 ${goal.iteration} 轮`;
}

/** Status line under the goal text, including why it is not advancing. */
export function goalStatusLine(goal: GoalState): string {
  const parts = [goal.status === "paused" ? "已暂停" : "进行中", `第 ${goal.iteration} 轮`];
  if (goal.status === "running" && goal.lastError) parts.push("上一轮出错，正在重试");
  if (goal.status === "paused") parts.push("发送 /goal 继续");
  return parts.join(" · ");
}
