import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDot,
  LoaderCircle,
  Square,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SubagentActivity, TodoItem } from "@suocode/runtime-protocol";

type ActivityTab = "todo" | "subagents";

function statusLabel(status: SubagentActivity["status"]): string {
  if (status === "pending") return "等待中";
  if (status === "running") return "执行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (status === "stopped") return "已停止";
  if (status === "paused") return "已暂停";
  return "已转入后台";
}

function agentSummary(activity: SubagentActivity): string {
  const parts: string[] = [];
  if (activity.turnCount !== undefined) parts.push(`${activity.turnCount} 轮`);
  if (activity.toolCount > 0) parts.push(`${activity.toolCount} 次工具`);
  if (activity.tokens > 0) parts.push(`${activity.tokens.toLocaleString("zh-CN")} tokens`);
  if (activity.currentTool) parts.push(`正在调用 ${activity.currentTool}`);
  return parts.join(" · ") || statusLabel(activity.status);
}

export function ActivityPanel({
  todo,
  subagents,
  onStopSubagent,
}: {
  todo: TodoItem[];
  subagents: SubagentActivity[];
  onStopSubagent: (activity: SubagentActivity) => void;
}): React.JSX.Element | null {
  const availableTabs = useMemo<ActivityTab[]>(() => [
    ...(todo.length ? ["todo" as const] : []),
    ...(subagents.length ? ["subagents" as const] : []),
  ], [subagents.length, todo.length]);
  const [tab, setTab] = useState<ActivityTab>(availableTabs[0] ?? "todo");
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (!availableTabs.includes(tab)) setTab(availableTabs[0] ?? "todo");
  }, [availableTabs, tab]);

  if (!availableTabs.length) return null;
  const completed = todo.filter((item) => item.status === "completed").length;
  const runningAgents = subagents.filter((item) => item.status === "pending" || item.status === "running" || item.status === "paused").length;
  const hasBoth = availableTabs.length > 1;
  const title = tab === "todo"
    ? "Todo"
    : runningAgents > 0 ? `${runningAgents} 个代理正在执行` : "代理执行记录";

  return (
    <section className={`composer-activity ${expanded ? "expanded" : "collapsed"}`} aria-label="Agent 活动">
      <div className="composer-activity-header">
        {hasBoth ? (
          <div className="composer-activity-tabs" role="tablist" aria-label="活动类型">
            <button className={tab === "todo" ? "active" : ""} type="button" role="tab" aria-selected={tab === "todo"} onClick={() => { setTab("todo"); setExpanded(true); }}>Todo</button>
            <button className={tab === "subagents" ? "active" : ""} type="button" role="tab" aria-selected={tab === "subagents"} onClick={() => { setTab("subagents"); setExpanded(true); }}>代理 <small>{runningAgents || subagents.length}</small></button>
          </div>
        ) : <strong>{title}</strong>}
        <button className="composer-activity-toggle" type="button" aria-label={expanded ? "收起活动" : "展开活动"} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          <small>{tab === "todo" ? `${completed}/${todo.length}` : `${runningAgents}/${subagents.length}`}</small>
          {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>
      <div className="composer-activity-body">
        {tab === "todo" ? (
          <ol className="composer-todo-list">
            {todo.map((item, index) => <li className={item.status} key={`${index}-${item.text}`}>
              {item.status === "completed" ? <CheckCircle2 size={14} /> : item.status === "in_progress" ? <CircleDot size={14} /> : <Circle size={14} />}
              <span>{item.text}</span>
            </li>)}
          </ol>
        ) : (
          <ol className="composer-subagent-list">
            {subagents.map((activity) => {
              const active = activity.status === "pending" || activity.status === "running" || activity.status === "paused";
              return <li className={activity.status} key={activity.id}>
                <span className="subagent-state-icon">{activity.status === "running" ? <LoaderCircle className="spin" size={14} /> : activity.status === "completed" ? <CheckCircle2 size={14} /> : <Bot size={14} />}</span>
                <span className="subagent-copy"><strong>{activity.agent}</strong>{activity.task ? <span>{activity.task}</span> : null}<small>{agentSummary(activity)}{activity.currentPath ? ` · ${activity.currentPath}` : ""}</small>{activity.error ? <small className="subagent-error">{activity.error}</small> : null}</span>
                {active ? <button className="subagent-stop" type="button" aria-label={`停止 ${activity.agent}`} onClick={() => onStopSubagent(activity)}><Square size={10} fill="currentColor" /><span>停止</span></button> : <small className="subagent-status">{statusLabel(activity.status)}</small>}
              </li>;
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
