import { Bot, CheckCircle2, ChevronRight, Circle, LoaderCircle, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { SubagentActivity, ToolRun } from "@suocode/runtime-protocol";

function isActive(activity: SubagentActivity): boolean {
  return activity.status === "pending" || activity.status === "running" || activity.status === "paused";
}

function statusLabel(status: SubagentActivity["status"]): string {
  if (status === "pending") return "等待中";
  if (status === "running") return "执行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (status === "stopped") return "已停止";
  if (status === "paused") return "已暂停";
  return "已转入后台";
}

function compactSummary(activities: SubagentActivity[], tool: ToolRun): string {
  if (!activities.length) return tool.status === "running" ? "正在启动子 Agent" : "子 Agent 执行记录";
  const running = activities.filter(isActive).length;
  const completed = activities.filter((activity) => activity.status === "completed").length;
  const tools = activities.reduce((total, activity) => total + activity.toolCount, 0);
  const turns = activities.reduce((total, activity) => total + (activity.turnCount ?? 0), 0);
  const parts = [running ? `${running} 个正在执行` : completed ? `${completed}/${activities.length} 个已完成` : `${activities.length} 个代理`];
  if (turns) parts.push(`${turns} 轮`);
  if (tools) parts.push(`${tools} 次工具`);
  return parts.join(" · ");
}

function roleLabel(role: string): string {
  if (role === "assistant") return "代理";
  if (role === "user") return "任务";
  if (role === "toolResult" || role === "tool") return "工具结果";
  return role;
}

function AgentDetails({ activity, onStop }: { activity: SubagentActivity; onStop: (activity: SubagentActivity) => void }): React.JSX.Element {
  return (
    <details className={`subagent-detail-agent ${activity.status}`} open={isActive(activity)}>
      <summary>
        <span className="subagent-detail-state">{activity.status === "running" ? <LoaderCircle className="spin" size={14} /> : activity.status === "completed" ? <CheckCircle2 size={14} /> : <Circle size={14} />}</span>
        <span><strong>{activity.agent}</strong><small>{activity.model ? `${activity.model} · ` : ""}{statusLabel(activity.status)}{activity.turnCount !== undefined ? ` · ${activity.turnCount} 轮` : ""}{activity.toolCount ? ` · ${activity.toolCount} 次工具` : ""}</small></span>
        {isActive(activity) ? <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onStop(activity); }}><Square size={9} fill="currentColor" />停止</button> : null}
      </summary>
      <div className="subagent-detail-content">
        {activity.task ? <section><h4>任务</h4><p>{activity.task}</p></section> : null}
        {activity.currentTool || activity.currentPath ? <section><h4>当前活动</h4><p>{[activity.currentTool ? `调用 ${activity.currentTool}` : "", activity.currentPath].filter(Boolean).join(" · ")}</p></section> : null}
        {activity.recentTools?.length ? <section><h4>最近工具</h4><ol>{activity.recentTools.map((tool, index) => <li key={`${tool.tool}-${index}`}><code>{tool.tool}</code><span>{tool.args}</span></li>)}</ol></section> : null}
        {activity.toolCalls?.length ? <section><h4>工具调用</h4><ol>{activity.toolCalls.map((call, index) => <li key={`${call.text}-${index}`}><strong>{call.text}</strong>{call.expandedText && call.expandedText !== call.text ? <pre>{call.expandedText}</pre> : null}</li>)}</ol></section> : null}
        {activity.messages?.length ? <section><h4>执行过程</h4><div className="subagent-message-list">{activity.messages.map((message, index) => <article key={`${message.role}-${index}`}><small>{roleLabel(message.role)}</small>{message.thinking ? <details><summary>Reasoning</summary><pre>{message.thinking}</pre></details> : null}{message.text ? <pre>{message.text}</pre> : null}</article>)}</div></section> : null}
        {activity.recentOutput?.length ? <section><h4>实时输出</h4><pre>{activity.recentOutput.join("\n")}</pre></section> : null}
        {activity.finalOutput ? <section><h4>最终输出</h4><pre>{activity.finalOutput}</pre></section> : null}
        {activity.error ? <section className="subagent-detail-error"><h4>错误</h4><pre>{activity.error}</pre></section> : null}
      </div>
    </details>
  );
}

function SubagentDetailWindow({ activities, onClose, onStop }: { activities: SubagentActivity[]; onClose: () => void; onStop: (activity: SubagentActivity) => void }): React.JSX.Element {
  const [position, setPosition] = useState(() => ({ x: Math.max(18, window.innerWidth - 560), y: 96 }));
  const dragRef = useRef<{ pointerX: number; pointerY: number; startX: number; startY: number } | undefined>(undefined);

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      setPosition({
        x: Math.max(8, Math.min(window.innerWidth - 340, drag.startX + event.clientX - drag.pointerX)),
        y: Math.max(8, Math.min(window.innerHeight - 80, drag.startY + event.clientY - drag.pointerY)),
      });
    };
    const end = (): void => { dragRef.current = undefined; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
  }, []);

  const beginDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest("button")) return;
    dragRef.current = { pointerX: event.clientX, pointerY: event.clientY, startX: position.x, startY: position.y };
    event.preventDefault();
  };

  return (
    <aside className="subagent-detail-window" style={{ left: position.x, top: position.y }} aria-label="子 Agent 详情">
      <header onPointerDown={beginDrag}><span><Bot size={15} /><strong>子 Agent 详情</strong><small>{activities.length} 个代理</small></span><button type="button" aria-label="关闭子 Agent 详情" onClick={onClose}><X size={15} /></button></header>
      <div className="subagent-detail-scroll">{activities.map((activity) => <AgentDetails activity={activity} key={activity.id} onStop={onStop} />)}</div>
    </aside>
  );
}

export function SubagentTimelineCard({ tool, activities, onStop }: { tool: ToolRun; activities: SubagentActivity[]; onStop: (activity: SubagentActivity) => void }): React.JSX.Element {
  const [detailOpen, setDetailOpen] = useState(false);
  const running = activities.some(isActive) || tool.status === "running";
  const title = useMemo(() => activities.length === 1 ? activities[0].task || activities[0].agent : activities.length ? `${activities.length} 个子 Agent` : "子 Agent", [activities]);
  return (
    <>
      <button className={`subagent-timeline-card ${running ? "running" : tool.status}`} type="button" onClick={() => setDetailOpen(true)}>
        <span className="subagent-card-icon">{running ? <LoaderCircle className="spin" size={15} /> : <Bot size={15} />}</span>
        <span><strong>{title}</strong><small>{compactSummary(activities, tool)}</small></span>
        <ChevronRight size={15} />
      </button>
      {detailOpen ? <SubagentDetailWindow activities={activities} onClose={() => setDetailOpen(false)} onStop={onStop} /> : null}
    </>
  );
}
