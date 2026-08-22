import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Circle,
  LoaderCircle,
  Play,
  Square,
  X,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import type { ChatMessage, SubagentActivity, SubagentTimelineEntry, ToolRun } from "@coilcoil/runtime-protocol";
import { AgentTurnView, type TimelineItem } from "../conversation/ConversationTimeline";

export function subagentIsActive(activity: SubagentActivity): boolean {
  return activity.status === "pending" || activity.status === "running";
}

function statusLabel(status: SubagentActivity["status"]): string {
  if (status === "pending") return "正在启动";
  if (status === "running") return "正在运行";
  if (status === "completed") return "已完成";
  if (status === "failed") return "执行失败";
  return "已停止";
}

function durationLabel(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function StatusIcon({ activity, size = 15 }: { activity: SubagentActivity; size?: number }): React.JSX.Element {
  if (activity.status === "pending" || activity.status === "running") return <LoaderCircle className="spin" size={size} />;
  if (activity.status === "completed") return <CheckCircle2 size={size} />;
  if (activity.status === "failed") return <AlertCircle size={size} />;
  if (activity.status === "stopped") return <Square size={Math.max(10, size - 3)} />;
  return <Circle size={size} />;
}

function activitySummary(activity: SubagentActivity): string {
  const parts = [statusLabel(activity.status)];
  if (activity.turnCount) parts.push(`${activity.turnCount} 轮`);
  if (activity.toolCount) parts.push(`${activity.toolCount} 次工具`);
  if (activity.durationMs > 0) parts.push(durationLabel(activity.durationMs));
  return parts.join(" · ");
}

export function SubagentCard({
  activity,
  onOpen,
  onStop,
  onResume,
  variant = "timeline",
}: {
  activity: SubagentActivity;
  onOpen: (activity: SubagentActivity) => void;
  /** Stop this subagent alone, leaving the parent turn running. */
  onStop?: (activity: SubagentActivity) => void;
  onResume?: (activity: SubagentActivity) => void;
  variant?: "timeline" | "panel";
}): React.JSX.Element {
  const stoppable = Boolean(onStop) && subagentIsActive(activity) && activity.controlReady === true;
  const resumable = Boolean(onResume) && activity.status === "stopped" && activity.resumable === true;
  const card = (
    <button
      className={`subagent-card ${variant} ${activity.status}`}
      type="button"
      aria-label={`查看子 Agent ${activity.agent} 的执行过程`}
      onClick={() => onOpen(activity)}
    >
      <span className="subagent-card-state"><StatusIcon activity={activity} /></span>
      <span className="subagent-card-copy">
        <strong>{activity.agent}</strong>
        {activity.task ? <span>{activity.task}</span> : null}
        {activity.modelInherited ? <em className="subagent-model-warning">模型由主 Agent 指定</em> : null}
      </span>
      <small className="subagent-card-meta" title={`${activitySummary(activity)}${activity.currentTool ? ` · 正在调用 ${activity.currentTool}` : ""}`}>
        {activitySummary(activity)}{activity.currentTool ? ` · 正在调用 ${activity.currentTool}` : ""}
      </small>
      <ChevronRight size={15} />
    </button>
  );
  if (!stoppable && !resumable) return card;
  // Controls sit beside the card rather than inside it: a card is itself a button.
  return (
    <div className="subagent-card-row">
      {card}
      {stoppable ? (
        <button
          className="subagent-card-control"
          type="button"
          aria-label={`停止子 Agent ${activity.agent}`}
          title="停止这个子 Agent"
          onClick={() => onStop?.(activity)}
        >
          <Square size={11} fill="currentColor" />
        </button>
      ) : null}
      {resumable ? (
        <button
          className="subagent-card-control"
          type="button"
          aria-label={`继续子 Agent ${activity.agent}`}
          title="继续这个子 Agent"
          onClick={() => onResume?.(activity)}
        >
          <Play size={11} fill="currentColor" />
        </button>
      ) : null}
    </div>
  );
}

function fallbackTimeline(activity: SubagentActivity): SubagentTimelineEntry[] {
  const entries: SubagentTimelineEntry[] = [];
  for (const message of activity.messages ?? []) {
    entries.push({
      id: `legacy-message-${entries.length}`,
      order: entries.length,
      kind: "message",
      role: message.role,
      text: message.text,
      thinking: message.thinking,
    });
  }
  for (const call of activity.toolCalls ?? []) {
    entries.push({
      id: `legacy-tool-${entries.length}`,
      order: entries.length,
      kind: "tool",
      tool: call.text.split(/\s+/, 1)[0] || "tool",
      args: call.text,
      expandedArgs: call.expandedText,
      status: "succeeded",
    });
  }
  if (!entries.length && activity.finalOutput) {
    entries.push({
      id: "legacy-final-output",
      order: 0,
      kind: "message",
      role: "assistant",
      text: activity.finalOutput,
    });
  }
  return entries;
}

function timelineItems(activity: SubagentActivity): TimelineItem[] {
  const source = [...(activity.timeline?.length ? activity.timeline : fallbackTimeline(activity))]
    .sort((left, right) => left.order - right.order);
  const items: TimelineItem[] = [];
  for (const entry of source) {
    if (entry.kind === "message") {
      const message: ChatMessage = {
        id: entry.id,
        order: entry.order,
        role: entry.role === "user" ? "user" : "assistant",
        text: entry.text,
        thinking: entry.thinking,
        timestamp: activity.updatedAt,
        status: subagentIsActive(activity) ? "running" : activity.status === "failed" ? "failed" : activity.status === "stopped" ? "aborted" : "succeeded",
      };
      items.push({ kind: "message", order: entry.order, message });
      continue;
    }
    const tool: ToolRun = {
      id: entry.id,
      order: entry.order,
      name: entry.tool,
      label: entry.args || `调用 ${entry.tool}`,
      args: entry.expandedArgs ? { detail: entry.expandedArgs } : entry.args ? { detail: entry.args } : {},
      output: entry.output ?? "",
      status: entry.status,
      startedAt: activity.updatedAt,
      endedAt: entry.status === "running" ? undefined : activity.updatedAt,
    };
    const previous = items.at(-1);
    if (previous?.kind === "tools") previous.tools.push(tool);
    else items.push({ kind: "tools", order: entry.order, tools: [tool] });
  }
  return items;
}

export function SubagentDetailDialog({
  activity,
  onClose,
}: {
  activity?: SubagentActivity;
  onClose: () => void;
}): React.JSX.Element | null {
  const items = useMemo(() => activity ? timelineItems(activity) : [], [activity]);

  useEffect(() => {
    if (!activity) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [activity, onClose]);

  if (!activity) return null;
  return createPortal(
    <div className="subagent-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="subagent-dialog" role="dialog" aria-modal="true" aria-label={`${activity.agent} 执行过程`}>
        <header>
          <span className={`subagent-dialog-state ${activity.status}`}><StatusIcon activity={activity} size={16} /></span>
          <span className="subagent-dialog-title">
            <strong>{activity.agent}</strong>
            <small>{activitySummary(activity)}{activity.model ? ` · ${activity.model}` : ""}</small>
          </span>
          <button type="button" aria-label="关闭子 Agent 详情" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="subagent-dialog-scroll">
          <div className="subagent-mini-chat">
            {activity.task ? (
              <article className="subagent-task-message">
                <span>父 Agent 指令</span>
                <div>{activity.task}</div>
              </article>
            ) : null}
            {items.length ? (
              <AgentTurnView
                items={items}
                modelName={activity.model ?? activity.agent}
                running={subagentIsActive(activity)}
              />
            ) : (
              <div className="subagent-dialog-empty"><Bot size={18} /><span>{subagentIsActive(activity) ? "子 Agent 正在准备执行…" : "暂无可显示的执行记录"}</span></div>
            )}
            {activity.error ? <div className="subagent-dialog-error">{activity.error}</div> : null}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
