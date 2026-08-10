import {
  Brain,
  Cable,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDot,
  FileText,
  Play,
  Sparkles,
  Terminal,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  PlanApprovalState,
  PlanExecutionTarget,
  SubagentActivity,
  TodoItem,
} from "@suocode/runtime-protocol";
import type { SlashMenuItem } from "../composer/useSlashSkills";
import { SubagentCard } from "../subagents/SubagentActivity";

type PermanentTab = "plan" | "todo" | "subagents";
type ActivityTab = PermanentTab | "commands";

const SUBAGENT_PROFILES = ["explore", "reviewer", "worker"] as const;

function planStatusLabel(status: PlanApprovalState["status"]): string {
  if (status === "pending_approval") return "等待审批";
  if (status === "running") return "主 Agent 执行中";
  if (status === "delegated") return "子 Agent 执行中";
  if (status === "completed") return "已完成";
  if (status === "rejected") return "已暂缓";
  return "执行失败";
}

function PlanApprovalView({
  plan,
  onApprove,
  onReject,
}: {
  plan: PlanApprovalState;
  onApprove: (planId: string, target: PlanExecutionTarget, agent?: string) => Promise<PlanApprovalState>;
  onReject: (planId: string) => Promise<PlanApprovalState>;
}): React.JSX.Element {
  const [profile, setProfile] = useState<string>("worker");
  const [pendingAction, setPendingAction] = useState<"main" | "subagent" | "reject">();
  const [error, setError] = useState<string>();
  const run = async (action: "main" | "subagent" | "reject"): Promise<void> => {
    if (pendingAction) return;
    setPendingAction(action);
    setError(undefined);
    try {
      if (action === "reject") await onReject(plan.id);
      else await onApprove(plan.id, action, action === "subagent" ? profile : undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPendingAction(undefined);
    }
  };

  return (
    <div className={`plan-approval-card status-${plan.status}`}>
      <div className="plan-approval-summary">
        <span className="plan-approval-icon"><FileText size={16} /></span>
        <span className="plan-approval-copy">
          <strong>{plan.title}</strong>
          <small>{planStatusLabel(plan.status)} · 已保存为可编辑计划文件</small>
        </span>
      </div>
      <p className="plan-approval-objective">{plan.objective}</p>
      <ol className="plan-approval-steps">
        {plan.steps.map((step) => (
          <li className={step.status} key={step.id}>
            {step.status === "completed" ? <CheckCircle2 size={13} /> : step.status === "in_progress" ? <CircleDot size={13} /> : <Circle size={13} />}
            <span>{step.text}</span>
          </li>
        ))}
      </ol>
      <section className="plan-approval-section">
        <strong>验收标准</strong>
        <ul>
          {plan.acceptanceCriteria.map((criterion, index) => <li key={`${index}-${criterion}`}>{criterion}</li>)}
        </ul>
      </section>
      {plan.notes ? <section className="plan-approval-section"><strong>补充说明</strong><p>{plan.notes}</p></section> : null}
      <div className="plan-file-path" title={plan.filePath}>
        <FileText size={12} />
        <span>{plan.filePath}</span>
      </div>
      {plan.status === "pending_approval" ? (
        <div className="plan-approval-actions">
          <button className="plan-primary-action" type="button" disabled={Boolean(pendingAction)} onClick={() => void run("main")}>
            <Play size={13} />{pendingAction === "main" ? "正在启动…" : "主 Agent 执行"}
          </button>
          <div className="plan-agent-picker" aria-label="选择子 Agent">
            {SUBAGENT_PROFILES.map((agent) => (
              <button className={profile === agent ? "active" : ""} type="button" key={agent} disabled={Boolean(pendingAction)} onClick={() => setProfile(agent)}>{agent}</button>
            ))}
            <input
              aria-label="子 Agent profile"
              disabled={Boolean(pendingAction)}
              list="plan-subagent-profiles"
              onChange={(event) => setProfile(event.target.value)}
              placeholder="其他 profile"
              value={SUBAGENT_PROFILES.includes(profile as (typeof SUBAGENT_PROFILES)[number]) ? "" : profile}
            />
            <datalist id="plan-subagent-profiles">{SUBAGENT_PROFILES.map((agent) => <option key={agent} value={agent} />)}</datalist>
          </div>
          <button type="button" disabled={Boolean(pendingAction) || !profile.trim()} onClick={() => void run("subagent")}>
            <Users size={13} />{pendingAction === "subagent" ? "正在派发…" : "派发给子 Agent"}
          </button>
          <button className="plan-reject-action" type="button" disabled={Boolean(pendingAction)} onClick={() => void run("reject")}>
            <X size={13} />暂不执行
          </button>
        </div>
      ) : null}
      {plan.status === "delegated" && plan.agentProfile ? <div className="plan-execution-note">由 {plan.agentProfile} 执行{plan.subagentRunId ? ` · ${plan.subagentRunId}` : ""}</div> : null}
      {plan.report ? <div className="plan-execution-report"><strong>执行报告</strong><p>{plan.report}</p></div> : null}
      {plan.error || error ? <div className="plan-approval-error">{error ?? plan.error}</div> : null}
    </div>
  );
}

function commandIcon(item: SlashMenuItem): React.JSX.Element {
  if (item.kind === "skill") return <Sparkles size={14} />;
  if (item.kind === "mcp") return <Cable size={14} />;
  if (item.kind === "command") return <Brain size={14} />;
  return <Terminal size={14} />;
}

export function ActivityPanel({
  todo,
  planApproval,
  subagents,
  commands,
  commandIndex = 0,
  onSelectCommand,
  onOpenSubagent,
  onApprovePlan,
  onRejectPlan,
}: {
  todo: TodoItem[];
  planApproval?: PlanApprovalState;
  subagents: SubagentActivity[];
  commands?: SlashMenuItem[];
  commandIndex?: number;
  onSelectCommand?: (item: SlashMenuItem) => void;
  onOpenSubagent: (activity: SubagentActivity) => void;
  onApprovePlan: (planId: string, target: PlanExecutionTarget, agent?: string) => Promise<PlanApprovalState>;
  onRejectPlan: (planId: string) => Promise<PlanApprovalState>;
}): React.JSX.Element | null {
  const commandsActive = commands !== undefined;
  const commandItems = commands ?? [];
  const permanentTabs = useMemo<PermanentTab[]>(() => [
    ...(planApproval ? ["plan" as const] : []),
    ...(todo.length ? ["todo" as const] : []),
    ...(subagents.length ? ["subagents" as const] : []),
  ], [planApproval, subagents.length, todo.length]);
  const availableTabs = useMemo<ActivityTab[]>(() => [
    ...permanentTabs,
    ...(commandsActive ? ["commands" as const] : []),
  ], [permanentTabs, commandsActive]);

  const [tab, setTab] = useState<ActivityTab>(availableTabs[0] ?? "plan");
  const [expanded, setExpanded] = useState(true);
  const previousPermanentTab = useRef<PermanentTab>(permanentTabs[0] ?? "plan");
  const activeCommandRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (tab === "plan" || tab === "todo" || tab === "subagents") previousPermanentTab.current = tab;
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
      return fallback ?? "plan";
    });
  }, [permanentTabs, commandsActive]);

  useEffect(() => {
    if (!availableTabs.includes(tab)) setTab(availableTabs[0] ?? "plan");
  }, [availableTabs, tab]);

  useEffect(() => {
    if (!commandsActive && planApproval?.status === "pending_approval") {
      setTab("plan");
      setExpanded(true);
    }
  }, [commandsActive, planApproval?.id, planApproval?.status]);

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
  const title = tab === "commands" ? "命令" : tab === "subagents" ? "代理" : tab === "plan" ? "计划" : "Todo";
  const toggleExpanded = (): void => setExpanded((value) => !value);
  const toggleLabel = tab === "commands"
    ? `${commandItems.length}`
    : tab === "plan"
      ? planApproval ? planStatusLabel(planApproval.status) : ""
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
            {permanentTabs.includes("plan") ? (
              <button className={tab === "plan" ? "active" : ""} type="button" role="tab" aria-selected={tab === "plan"} onClick={() => { setTab("plan"); setExpanded(true); }}>计划</button>
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
        ) : tab === "plan" && planApproval ? (
          <PlanApprovalView plan={planApproval} onApprove={onApprovePlan} onReject={onRejectPlan} />
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
              <li key={activity.id}><SubagentCard activity={activity} variant="panel" onOpen={onOpenSubagent} /></li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
