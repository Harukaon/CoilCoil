import {
  Brain,
  Cable,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDot,
  Sparkles,
  Terminal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TodoItem } from "@suocode/runtime-protocol";
import type { SlashMenuItem } from "../composer/useSlashSkills";

type ActivityTab = "todo" | "commands";

function commandIcon(item: SlashMenuItem): React.JSX.Element {
  if (item.kind === "skill") return <Sparkles size={14} />;
  if (item.kind === "mcp") return <Cable size={14} />;
  if (item.kind === "command") return <Brain size={14} />;
  return <Terminal size={14} />;
}

export function ActivityPanel({
  todo,
  commands,
  commandIndex = 0,
  onSelectCommand,
}: {
  todo: TodoItem[];
  commands?: SlashMenuItem[];
  commandIndex?: number;
  onSelectCommand?: (item: SlashMenuItem) => void;
}): React.JSX.Element | null {
  const commandsActive = commands !== undefined;
  const commandItems = commands ?? [];
  const permanentTabs = useMemo<ActivityTab[]>(() => (todo.length ? ["todo" as const] : []), [todo.length]);
  const availableTabs = useMemo<ActivityTab[]>(() => [
    ...permanentTabs,
    ...(commandsActive ? ["commands" as const] : []),
  ], [permanentTabs, commandsActive]);

  const [tab, setTab] = useState<ActivityTab>(availableTabs[0] ?? "todo");
  const [expanded, setExpanded] = useState(true);
  const previousPermanentTab = useRef<ActivityTab>(permanentTabs[0] ?? "todo");
  const activeCommandRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (tab === "todo") previousPermanentTab.current = tab;
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
  const showTabs = availableTabs.length > 1;
  const title = tab === "commands" ? "命令" : "Todo";
  const toggleExpanded = (): void => setExpanded((value) => !value);
  const toggleLabel = tab === "commands" ? `${commandItems.length}` : `${completed}/${todo.length}`;

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
        ) : (
          <ol className="composer-todo-list">
            {todo.map((item, index) => <li className={item.status} key={`${index}-${item.text}`}>
              {item.status === "completed" ? <CheckCircle2 size={14} /> : item.status === "in_progress" ? <CircleDot size={14} /> : <Circle size={14} />}
              <span>{item.text}</span>
            </li>)}
          </ol>
        )}
      </div>
    </section>
  );
}
