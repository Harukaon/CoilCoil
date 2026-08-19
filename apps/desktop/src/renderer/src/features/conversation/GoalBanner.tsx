import { CircleCheck, Square, Target } from "lucide-react";
import type { GoalState } from "@suocode/runtime-protocol";

const STATUS_LABEL: Record<GoalState["status"], string> = {
  running: "目标进行中",
  paused: "目标已暂停",
  completed: "目标已完成",
  stopped: "目标已停止",
};

/** Live state of a `/goal` loop, with the only control that ends it. */
export function GoalBanner({
  goal,
  onStop,
}: {
  goal?: GoalState;
  onStop: () => void;
}): React.JSX.Element | null {
  if (!goal) return null;
  const running = goal.status === "running";
  return (
    <div className={`goal-banner status-${goal.status}`}>
      <span className="goal-banner-icon" aria-hidden="true">
        {goal.status === "completed" ? <CircleCheck size={14} /> : <Target size={14} />}
      </span>
      <div className="goal-banner-copy">
        <strong>{goal.goal}</strong>
        <small>
          {STATUS_LABEL[goal.status]} · 第 {goal.iteration} 轮
          {goal.lastError && running ? ` · 上一轮出错，正在重试` : ""}
          {goal.status === "paused" ? " · 发送 /goal 继续" : ""}
        </small>
      </div>
      {running ? (
        <button className="goal-banner-stop" type="button" onClick={onStop}>
          <Square size={11} fill="currentColor" />
          <span>停止</span>
        </button>
      ) : null}
    </div>
  );
}
