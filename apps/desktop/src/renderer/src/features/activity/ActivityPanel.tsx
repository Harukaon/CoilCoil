import {
  ArrowUp,
  Brain,
  Cable,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDot,
  Clock,
  LoaderCircle,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, SubagentActivity, TodoItem } from "@suocode/runtime-protocol";
import type { SlashMenuItem } from "../composer/useSlashSkills";
import { SubagentCard } from "../subagents/SubagentActivity";

type PermanentTab = "queue" | "todo" | "subagents";
type ActivityTab = PermanentTab | "commands";

function commandIcon(item: SlashMenuItem): React.JSX.Element {
  if (item.kind === "skill") return <Sparkles size={14} />;
  if (item.kind === "mcp") return <Cable size={14} />;
  if (item.kind === "command") return <Brain size={14} />;
  return <Terminal size={14} />;
}

export function ActivityPanel({
  todo,
  subagents,
  queued,
  commands,
  commandIndex = 0,
  onSelectCommand,
  onOpenSubagent,
  onCancelQueued,
  onPromoteQueued,
  onStopSubagent,
  onResumeSubagent,
}: {
  todo: TodoItem[];
  subagents: SubagentActivity[];
  /** Accepted but not yet sent, oldest first. */
  queued?: ChatMessage[];
  commands?: SlashMenuItem[];
  commandIndex?: number;
  onSelectCommand?: (item: SlashMenuItem) => void;
  onOpenSubagent: (activity: SubagentActivity) => void;
  onCancelQueued?: (id: string) => void;
  /** Interject a queued message into the turn that is already running. */
  onPromoteQueued?: (id: string) => void;
  onStopSubagent?: (activity: SubagentActivity) => void;
  onResumeSubagent?: (activity: SubagentActivity) => void;
}): React.JSX.Element | null {
  const commandsActive = commands !== undefined;
  const commandItems = commands ?? [];
  const queuedItems = useMemo(() => queued ?? [], [queued]);
  const permanentTabs = useMemo<PermanentTab[]>(() => [
    ...(queuedItems.length ? ["queue" as const] : []),
    ...(todo.length ? ["todo" as const] : []),
    ...(subagents.length ? ["subagents" as const] : []),
  ], [queuedItems.length, subagents.length, todo.length]);
  const availableTabs = useMemo<ActivityTab[]>(() => [
    ...permanentTabs,
    ...(commandsActive ? ["commands" as const] : []),
  ], [permanentTabs, commandsActive]);

  const [tab, setTab] = useState<ActivityTab>(availableTabs[0] ?? "todo");
  const [expanded, setExpanded] = useState(true);
  const previousPermanentTab = useRef<PermanentTab>(permanentTabs[0] ?? "todo");
  const activeCommandRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (tab !== "commands") previousPermanentTab.current = tab;
  }, [tab]);

  // A message the user just queued is the thing they want to act on, so the
  // panel surfaces it rather than waiting to be opened.
  const hadQueued = useRef(queuedItems.length > 0);
  useEffect(() => {
    const hasQueued = queuedItems.length > 0;
    if (hasQueued && !hadQueued.current && !commandsActive) {
      setTab("queue");
      setExpanded(true);
    }
    hadQueued.current = hasQueued;
  }, [commandsActive, queuedItems.length]);

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
  const failedAgents = subagents.filter((item) => item.status === "failed").length;
  const stoppedAgents = subagents.filter((item) => item.status === "stopped").length;
  const showTabs = availableTabs.length > 1;
  const title = tab === "commands" ? "命令" : tab === "subagents" ? "代理" : tab === "queue" ? "队列" : "Todo";
  const toggleExpanded = (): void => setExpanded((value) => !value);
  const toggleLabel = tab === "commands"
    ? `${commandItems.length}`
    : tab === "queue"
      ? `${queuedItems.length} 条待发`
    : tab === "subagents"
      ? runningAgents
        ? `${runningAgents} 个运行中`
        : failedAgents
          ? `${failedAgents} 个失败`
          : stoppedAgents
            ? "已结束"
            : "全部完成"
      : `${completed}/${todo.length}`;

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
            {permanentTabs.includes("queue") ? (
              <button className={tab === "queue" ? "active" : ""} type="button" role="tab" aria-selected={tab === "queue"} onClick={() => { setTab("queue"); setExpanded(true); }}>队列 <small>{queuedItems.length}</small></button>
            ) : null}
            {permanentTabs.includes("todo") ? (
              <button className={tab === "todo" ? "active" : ""} type="button" role="tab" aria-selected={tab === "todo"} onClick={() => { setTab("todo"); setExpanded(true); }}>Todo</button>
            ) : null}
            {permanentTabs.includes("subagents") ? (
              <button className={tab === "subagents" ? "active" : ""} type="button" role="tab" aria-selected={tab === "subagents"} onClick={() => { setTab("subagents"); setExpanded(true); }}>代理</button>
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
        ) : tab === "queue" ? (
          <ol className="composer-queue-list" aria-label="排队中的消息">
            {queuedItems.map((item, index) => {
              const promoting = item.status === "running";
              return (
              <li key={item.id}>
                <span className="composer-queue-index" aria-hidden="true">{index + 1}</span>
                <span className="composer-queue-text" title={item.text}>{item.text}</span>
                {item.images?.length ? <span className="composer-queue-badge">{item.images.length} 图</span> : null}
                {onPromoteQueued ? (
                  <button
                    type="button"
                    aria-label={promoting ? `第 ${index + 1} 条排队消息正在介入` : `让第 ${index + 1} 条排队消息介入当前轮次`}
                    title={promoting ? "正在介入当前轮次…" : "介入当前轮次"}
                    disabled={promoting}
                    onClick={() => onPromoteQueued(item.id)}
                  >
                    {promoting ? <LoaderCircle className="spin" size={12} /> : <ArrowUp size={12} />}
                  </button>
                ) : null}
                {onCancelQueued ? (
                  <button
                    type="button"
                    aria-label={`撤回第 ${index + 1} 条排队消息`}
                    title={promoting ? "正在发送，无法撤回" : "撤回"}
                    disabled={promoting}
                    onClick={() => onCancelQueued(item.id)}
                  >
                    <X size={12} />
                  </button>
                ) : null}
              </li>
              );
            })}
            <li className="composer-queue-hint"><Clock size={10} />当前回复结束后按顺序发送；↑ 立即介入这一轮</li>
          </ol>
        ) : tab === "todo" ? (
          <ol className="composer-todo-list">
            {todo.map((item, index) => <li className={item.status} key={`${index}-${item.text}`}>
              {item.status === "completed" ? <CheckCircle2 size={14} /> : item.status === "in_progress" ? <CircleDot size={14} /> : <Circle size={14} />}
              <span>{item.text}</span>
            </li>)}
          </ol>
        ) : (
          <ol className="composer-subagent-list">
            {subagents.map((activity) => (
              <li key={activity.id}>
                <SubagentCard
                  activity={activity}
                  variant="panel"
                  onOpen={onOpenSubagent}
                  onStop={onStopSubagent}
                  onResume={onResumeSubagent}
                />
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
