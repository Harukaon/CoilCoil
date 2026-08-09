import {
  Bot,
  Brain,
  Cable,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDot,
  LoaderCircle,
  Square,
  Sparkles,
  Terminal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SubagentActivity, TodoItem } from "@suocode/runtime-protocol";
import type { SlashMenuItem } from "../composer/useSlashSkills";

type PermanentTab = "todo" | "subagents";
type ActivityTab = PermanentTab | "commands";

function statusLabel(status: SubagentActivity["status"]): string {
  if (status === "pending") return "等待中";
  if (status === "running") return "执行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  return "已停止";
}

function agentSummary(activity: SubagentActivity): string {
  const parts: string[] = [];
  if (activity.turnCount !== undefined) parts.push(`${activity.turnCount} 轮`);
  if (activity.toolCount > 0) parts.push(`${activity.toolCount} 次工具`);
  if (activity.tokens > 0) parts.push(`${activity.tokens.toLocaleString("zh-CN")} tokens`);
  if (activity.currentTool) parts.push(`正在调用 ${activity.currentTool}`);
  return parts.join(" · ") || statusLabel(activity.status);
}

function commandIcon(item: SlashMenuItem): React.JSX.Element {
  if (item.kind === "skill") return <Sparkles size={14} />;
  if (item.kind === "mcp") return <Cable size={14} />;
  if (item.kind === "command") return <Brain size={14} />;
  return <Terminal size={14} />;
}

export function ActivityPanel({
  todo,
  subagents,
  commands,
  commandIndex = 0,
  onSelectCommand,
  onStopSubagent,
}: {
  todo: TodoItem[];
  subagents: SubagentActivity[];
  commands?: SlashMenuItem[];
  commandIndex?: number;
  onSelectCommand?: (item: SlashMenuItem) => void;
  onStopSubagent: (activity: SubagentActivity) => void;
}): React.JSX.Element | null {
  const commandsActive = commands !== undefined;
  const commandItems = commands ?? [];
  const permanentTabs = useMemo<PermanentTab[]>(() => [
    ...(todo.length ? ["todo" as const] : []),
    ...(subagents.length ? ["subagents" as const] : []),
  ], [subagents.length, todo.length]);
  const availableTabs = useMemo<ActivityTab[]>(() => [
    ...permanentTabs,
    ...(commandsActive ? ["commands" as const] : []),
  ], [permanentTabs, commandsActive]);

  const [tab, setTab] = useState<ActivityTab>(availableTabs[0] ?? "todo");
  const [expanded, setExpanded] = useState(true);
  const previousPermanentTab = useRef<PermanentTab>(permanentTabs[0] ?? "todo");
  const activeCommandRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (tab === "todo" || tab === "subagents") previousPermanentTab.current = tab;
  }, [tab]);

  useEffect(() => {
    if (commandsActive) {
      setTab("commands");
      setExpanded(true);
      return;
    }
    setTab((current) => {
      if (current !== "commands") return current;
      const fallback = permanentTabs.includes(previousPermanentTab.current)
        ? previousPermanentTab.current
        : permanentTabs[0];
      return fallback ?? "todo";
    });
  }, [permanentTabs, commandsActive]);

  useEffect(() => {
    if (!availableTabs.includes(tab)) setTab(availableTabs[0] ?? "todo");
  }, [availableTabs, tab]);

  useEffect(() => {
    if (!commandsActive || tab !== "commands") return;
    const item = activeCommandRef.current;
    const scroller = item?.closest("ol");
    if (!item || !(scroller instanceof HTMLElement)) return;
    // Composer tucks over the activity panel; leave room so the active row is fully visible.
    const overlap = Number.parseFloat(getComputedStyle(scroller).scrollPaddingBottom) || 20;
    const itemRect = item.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const visibleBottom = scrollerRect.bottom - overlap;
    if (itemRect.bottom > visibleBottom) {
      scroller.scrollTop += itemRect.bottom - visibleBottom;
      return;
    }
    if (itemRect.top < scrollerRect.top) {
      scroller.scrollTop -= scrollerRect.top - itemRect.top;
    }
  }, [commandIndex, commandsActive, commandItems.length, tab]);

  if (!availableTabs.length) return null;

  const completed = todo.filter((item) => item.status === "completed").length;
  const runningAgents = subagents.filter((item) => item.status === "pending" || item.status === "running").length;
  const showTabs = availableTabs.length > 1;
  const title = tab === "commands"
    ? "命令"
    : tab === "todo"
      ? "Todo"
      : runningAgents > 0 ? `${runningAgents} 个代理正在执行` : "代理执行记录";
  const toggleExpanded = (): void => setExpanded((value) => !value);
  const toggleLabel = tab === "commands"
    ? `${commandItems.length}`
    : tab === "todo"
      ? `${completed}/${todo.length}`
      : `${runningAgents}/${subagents.length}`;

  return (
    <section className={`composer-activity ${expanded ? "expanded" : "collapsed"}`} aria-label="Agent 活动">
      <div
        className="composer-activity-header"
        role="button"
        tabIndex={0}
        aria-label={expanded ? "收起活动" : "展开活动"}
        aria-expanded={expanded}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          toggleExpanded();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          toggleExpanded();
        }}
      >
        {showTabs ? (
          <div className="composer-activity-tabs" role="tablist" aria-label="活动类型">
            {permanentTabs.includes("todo") ? (
              <button className={tab === "todo" ? "active" : ""} type="button" role="tab" aria-selected={tab === "todo"} onClick={() => { setTab("todo"); setExpanded(true); }}>Todo</button>
            ) : null}
            {permanentTabs.includes("subagents") ? (
              <button className={tab === "subagents" ? "active" : ""} type="button" role="tab" aria-selected={tab === "subagents"} onClick={() => { setTab("subagents"); setExpanded(true); }}>代理 <small>{runningAgents || subagents.length}</small></button>
            ) : null}
            {commandsActive ? (
              <button className={tab === "commands" ? "active" : ""} type="button" role="tab" aria-selected={tab === "commands"} onClick={() => { setTab("commands"); setExpanded(true); }}>命令 <small>{commandItems.length}</small></button>
            ) : null}
          </div>
        ) : <strong>{title}</strong>}
        <button className="composer-activity-toggle" type="button" aria-label={expanded ? "收起活动" : "展开活动"} aria-expanded={expanded} onClick={toggleExpanded}>
          <small>{toggleLabel}</small>
          {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>
      <div className="composer-activity-body">
        {tab === "commands" && commandsActive ? (
          commandItems.length ? (
            <ol className="composer-command-list" role="listbox" aria-label="斜杠命令">
              {commandItems.map((item, index) => (
                <li key={item.id}>
                  <button
                    ref={index === commandIndex ? activeCommandRef : undefined}
                    type="button"
                    role="option"
                    aria-selected={index === commandIndex}
                    className={index === commandIndex ? "active" : ""}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onSelectCommand?.(item)}
                  >
                    <span className="composer-command-icon">{commandIcon(item)}</span>
                    <span className="composer-command-copy">
                      <strong>{item.title}</strong>
                      <small>{item.description}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <div className="composer-command-empty">没有匹配的命令。</div>
          )
        ) : tab === "todo" ? (
          <ol className="composer-todo-list">
            {todo.map((item, index) => <li className={item.status} key={`${index}-${item.text}`}>
              {item.status === "completed" ? <CheckCircle2 size={14} /> : item.status === "in_progress" ? <CircleDot size={14} /> : <Circle size={14} />}
              <span>{item.text}</span>
            </li>)}
          </ol>
        ) : (
          <ol className="composer-subagent-list">
            {subagents.map((activity) => {
              const active = activity.status === "pending" || activity.status === "running";
              const controllable = active && activity.controlReady === true;
              return <li className={activity.status} key={activity.id}>
                <span className="subagent-state-icon">{activity.status === "running" ? <LoaderCircle className="spin" size={14} /> : activity.status === "completed" ? <CheckCircle2 size={14} /> : <Bot size={14} />}</span>
                <span className="subagent-copy"><strong>{activity.agent}</strong>{activity.task ? <span>{activity.task}</span> : null}<small>{agentSummary(activity)}{activity.currentPath ? ` · ${activity.currentPath}` : ""}</small>{activity.error ? <small className="subagent-error">{activity.error}</small> : null}</span>
                {controllable
                  ? <button className="subagent-stop" type="button" aria-label={`停止 ${activity.agent}`} onClick={() => onStopSubagent(activity)}><Square size={10} fill="currentColor" /><span>停止</span></button>
                  : <small className="subagent-status">{active ? "启动中" : statusLabel(activity.status)}</small>}
              </li>;
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
